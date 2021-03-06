/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, toDisposable, IDisposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { IKeymapService, IKeyboardLayoutInfo, IKeyboardMapping, IWindowsKeyboardMapping, KeymapInfo, IRawMixedKeyboardMapping, getKeyboardLayoutId, IKeymapInfo } from 'vs/workbench/services/keybinding/common/keymapInfo';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { DispatchConfig } from 'vs/workbench/services/keybinding/common/dispatchConfig';
import { IKeyboardMapper, CachedKeyboardMapper } from 'vs/workbench/services/keybinding/common/keyboardMapper';
import { OS, OperatingSystem, isMacintosh, isWindows } from 'vs/base/common/platform';
import { WindowsKeyboardMapper } from 'vs/workbench/services/keybinding/common/windowsKeyboardMapper';
import { MacLinuxFallbackKeyboardMapper } from 'vs/workbench/services/keybinding/common/macLinuxFallbackKeyboardMapper';
import { IKeyboardEvent } from 'vs/platform/keybinding/common/keybinding';
import { IMacLinuxKeyboardMapping, MacLinuxKeyboardMapper } from 'vs/workbench/services/keybinding/common/macLinuxKeyboardMapper';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { URI } from 'vs/base/common/uri';
import { IFileService, FileChangesEvent, FileChangeType } from 'vs/platform/files/common/files';
import { RunOnceScheduler } from 'vs/base/common/async';
import { dirname, isEqual } from 'vs/base/common/resources';
import { parse } from 'vs/base/common/json';
import * as objects from 'vs/base/common/objects';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { Registry } from 'vs/platform/registry/common/platform';
import { Extensions as ConfigExtensions, IConfigurationRegistry, IConfigurationNode } from 'vs/platform/configuration/common/configurationRegistry';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { INavigatorWithKeyboard } from 'vs/workbench/services/keybinding/common/navigatorKeyboard';

export class BrowserKeyboardMapperFactoryBase {
	// keyboard mapper
	protected _initialized: boolean;
	protected _keyboardMapper: IKeyboardMapper | null;
	private readonly _onDidChangeKeyboardMapper = new Emitter<void>();
	public readonly onDidChangeKeyboardMapper: Event<void> = this._onDidChangeKeyboardMapper.event;

	// keymap infos
	protected _keymapInfos: KeymapInfo[];
	protected _mru: KeymapInfo[];
	private _activeKeymapInfo: KeymapInfo | null;

	get activeKeymap(): KeymapInfo | null {
		return this._activeKeymapInfo;
	}

	get keymapInfos(): KeymapInfo[] {
		return this._keymapInfos;
	}

	get activeKeyboardLayout(): IKeyboardLayoutInfo | null {
		if (!this._initialized) {
			return null;
		}

		return this._activeKeymapInfo && this._activeKeymapInfo.layout;
	}

	get activeKeyMapping(): IKeyboardMapping | null {
		if (!this._initialized) {
			return null;
		}

		return this._activeKeymapInfo && this._activeKeymapInfo.mapping;
	}

	get keyboardLayouts(): IKeyboardLayoutInfo[] {
		return this._keymapInfos.map(keymapInfo => keymapInfo.layout);
	}

	protected constructor() {
		this._keyboardMapper = null;
		this._initialized = false;
		this._keymapInfos = [];
		this._mru = [];
		this._activeKeymapInfo = null;

		if ((<INavigatorWithKeyboard>navigator).keyboard && (<INavigatorWithKeyboard>navigator).keyboard.addEventListener) {
			(<INavigatorWithKeyboard>navigator).keyboard.addEventListener!('layoutchange', () => {
				// Update user keyboard map settings
				this._getBrowserKeyMapping().then((mapping: IKeyboardMapping | null) => {
					if (this.isKeyMappingActive(mapping)) {
						return;
					}

					this.onKeyboardLayoutChanged();
				});
			});
		}
	}

	registerKeyboardLayout(layout: KeymapInfo) {
		this._keymapInfos.push(layout);
		this._mru = this._keymapInfos;
	}

	removeKeyboardLayout(layout: KeymapInfo): void {
		let index = this._mru.indexOf(layout);
		this._mru.splice(index, 1);
		index = this._keymapInfos.indexOf(layout);
		this._keymapInfos.splice(index, 1);
	}

	getMatchedKeymapInfo(keyMapping: IKeyboardMapping | null): KeymapInfo | null {
		if (!keyMapping) {
			return null;
		}

		let usStandard = this.getUSStandardLayout();

		if (usStandard) {
			let maxScore = usStandard.getScore(keyMapping);
			if (maxScore === 0) {
				return usStandard;
			}

			let result = usStandard;
			for (let i = 0; i < this._mru.length; i++) {
				let score = this._mru[i].getScore(keyMapping);
				if (score > maxScore) {
					if (score === 0) {
						return this._mru[i];
					}

					maxScore = score;
					result = this._mru[i];
				}
			}

			return result;
		}

		for (let i = 0; i < this._mru.length; i++) {
			if (this._mru[i].fuzzyEqual(keyMapping)) {
				return this._mru[i];
			}
		}

		return null;
	}

	getUSStandardLayout() {
		const usStandardLayouts = this._mru.filter(layout => layout.layout.isUSStandard);

		if (usStandardLayouts.length) {
			return usStandardLayouts[0];
		}

		return null;
	}

	isKeyMappingActive(keymap: IKeyboardMapping | null) {
		return this._activeKeymapInfo && keymap && this._activeKeymapInfo.fuzzyEqual(keymap);
	}

	setUSKeyboardLayout() {
		this._activeKeymapInfo = this.getUSStandardLayout();
	}

	setActiveKeyMapping(keymap: IKeyboardMapping | null) {
		let matchedKeyboardLayout = this.getMatchedKeymapInfo(keymap);
		if (matchedKeyboardLayout) {
			if (!this._activeKeymapInfo) {
				this._activeKeymapInfo = matchedKeyboardLayout;
			} else if (keymap) {
				if (matchedKeyboardLayout.getScore(keymap) > this._activeKeymapInfo.getScore(keymap)) {
					this._activeKeymapInfo = matchedKeyboardLayout;
				}
			}
		}

		if (!this._activeKeymapInfo) {
			this._activeKeymapInfo = this.getUSStandardLayout();
		}

		if (!this._activeKeymapInfo) {
			return;
		}

		const index = this._mru.indexOf(this._activeKeymapInfo);

		this._mru.splice(index, 1);
		this._mru.unshift(this._activeKeymapInfo);

		this._setKeyboardData(this._activeKeymapInfo);
	}

	setActiveKeymapInfo(keymapInfo: KeymapInfo) {
		this._activeKeymapInfo = keymapInfo;

		const index = this._mru.indexOf(this._activeKeymapInfo);

		if (index === 0) {
			return;
		}

		this._mru.splice(index, 1);
		this._mru.unshift(this._activeKeymapInfo);

		this._setKeyboardData(this._activeKeymapInfo);
	}

	public onKeyboardLayoutChanged(): void {
		this._updateKeyboardLayoutAsync(this._initialized);
	}

	private _updateKeyboardLayoutAsync(initialized: boolean, keyboardEvent?: IKeyboardEvent) {
		if (!initialized) {
			return;
		}

		this._getBrowserKeyMapping(keyboardEvent).then(keyMap => {
			// might be false positive
			if (this.isKeyMappingActive(keyMap)) {
				return;
			}
			this.setActiveKeyMapping(keyMap);
		});
	}

	public getKeyboardMapper(dispatchConfig: DispatchConfig): IKeyboardMapper {
		if (!this._initialized) {
			return new MacLinuxFallbackKeyboardMapper(OS);
		}
		if (dispatchConfig === DispatchConfig.KeyCode) {
			// Forcefully set to use keyCode
			return new MacLinuxFallbackKeyboardMapper(OS);
		}
		return this._keyboardMapper!;
	}

	public validateCurrentKeyboardMapping(keyboardEvent: IKeyboardEvent): void {
		if (!this._initialized) {
			return;
		}

		let isCurrentKeyboard = this._validateCurrentKeyboardMapping(keyboardEvent);

		if (isCurrentKeyboard) {
			return;
		}

		this._updateKeyboardLayoutAsync(true, keyboardEvent);
	}

	public setKeyboardLayout(layoutName: string) {
		let matchedLayouts: KeymapInfo[] = this.keymapInfos.filter(keymapInfo => getKeyboardLayoutId(keymapInfo.layout) === layoutName);

		if (matchedLayouts.length > 0) {
			this.setActiveKeymapInfo(matchedLayouts[0]);
		}
	}

	private _setKeyboardData(keymapInfo: KeymapInfo): void {
		this._initialized = true;

		this._keyboardMapper = new CachedKeyboardMapper(BrowserKeyboardMapperFactory._createKeyboardMapper(keymapInfo));
		this._onDidChangeKeyboardMapper.fire();
	}

	private static _createKeyboardMapper(keymapInfo: KeymapInfo): IKeyboardMapper {
		let rawMapping = keymapInfo.mapping;
		const isUSStandard = !!keymapInfo.layout.isUSStandard;
		if (OS === OperatingSystem.Windows) {
			return new WindowsKeyboardMapper(isUSStandard, <IWindowsKeyboardMapping>rawMapping);
		}
		if (Object.keys(rawMapping).length === 0) {
			// Looks like reading the mappings failed (most likely Mac + Japanese/Chinese keyboard layouts)
			return new MacLinuxFallbackKeyboardMapper(OS);
		}

		return new MacLinuxKeyboardMapper(isUSStandard, <IMacLinuxKeyboardMapping>rawMapping, OS);
	}

	//#region Browser API
	private _validateCurrentKeyboardMapping(keyboardEvent: IKeyboardEvent): boolean {
		if (!this._initialized) {
			return true;
		}

		const standardKeyboardEvent = keyboardEvent as StandardKeyboardEvent;
		const currentKeymap = this._activeKeymapInfo;
		if (!currentKeymap) {
			return true;
		}

		const mapping = currentKeymap.mapping[standardKeyboardEvent.code];

		if (!mapping) {
			return false;
		}

		if (mapping.value === '') {
			// we don't undetstand
			if (keyboardEvent.ctrlKey || keyboardEvent.metaKey) {
				setTimeout(() => {
					this._getBrowserKeyMapping().then((keymap: IKeyboardMapping) => {
						if (this.isKeyMappingActive(keymap)) {
							return;
						}

						this.onKeyboardLayoutChanged();
					});
				}, 350);
			}
			return true;
		}

		const expectedValue = standardKeyboardEvent.altKey && standardKeyboardEvent.shiftKey ? mapping.withShiftAltGr :
			standardKeyboardEvent.altKey ? mapping.withAltGr :
				standardKeyboardEvent.shiftKey ? mapping.withShift : mapping.value;

		const isDead = (standardKeyboardEvent.altKey && standardKeyboardEvent.shiftKey && mapping.withShiftAltGrIsDeadKey) ||
			(standardKeyboardEvent.altKey && mapping.withAltGrIsDeadKey) ||
			(standardKeyboardEvent.shiftKey && mapping.withShiftIsDeadKey) ||
			mapping.valueIsDeadKey;

		if (isDead && standardKeyboardEvent.browserEvent.key !== 'Dead') {
			return false;
		}

		// TODO, this assumption is wrong as `browserEvent.key` doesn't necessarily equal expectedValue from real keymap
		if (!isDead && standardKeyboardEvent.browserEvent.key !== expectedValue) {
			return false;
		}

		return true;
	}

	private async _getBrowserKeyMapping(keyboardEvent?: IKeyboardEvent): Promise<IRawMixedKeyboardMapping | null> {
		if ((navigator as any).keyboard) {
			try {
				return (navigator as any).keyboard.getLayoutMap().then((e: any) => {
					let ret: IKeyboardMapping = {};
					for (let key of e) {
						ret[key[0]] = {
							'value': key[1],
							'withShift': '',
							'withAltGr': '',
							'withShiftAltGr': ''
						};
					}

					const matchedKeyboardLayout = this.getMatchedKeymapInfo(ret);

					if (matchedKeyboardLayout) {
						return matchedKeyboardLayout.mapping;
					}

					return null;
				});
			} catch {
				// getLayoutMap can throw if invoked from a nested browsing context
			}
		} else if (keyboardEvent && !keyboardEvent.shiftKey && !keyboardEvent.altKey && !keyboardEvent.metaKey && !keyboardEvent.metaKey) {
			let ret: IKeyboardMapping = {};
			const standardKeyboardEvent = keyboardEvent as StandardKeyboardEvent;
			ret[standardKeyboardEvent.browserEvent.code] = {
				'value': standardKeyboardEvent.browserEvent.key,
				'withShift': '',
				'withAltGr': '',
				'withShiftAltGr': ''
			};

			const matchedKeyboardLayout = this.getMatchedKeymapInfo(ret);

			if (matchedKeyboardLayout) {
				return ret;
			}

			return null;
		}

		return null;
	}

	//#endregion
}

export class BrowserKeyboardMapperFactory extends BrowserKeyboardMapperFactoryBase {
	public static readonly INSTANCE = new BrowserKeyboardMapperFactory();
	// keyboard mapper

	private constructor() {
		super();

		const platform = isWindows ? 'win' : isMacintosh ? 'darwin' : 'linux';

		import('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.' + platform).then((m) => {
			let keymapInfos: IKeymapInfo[] = m.KeyboardLayoutContribution.INSTANCE.layoutInfos;
			this._keymapInfos.push(...keymapInfos.map(info => (new KeymapInfo(info.layout, info.secondaryLayouts, info.mapping, info.isUserKeyboardLayout))));
			this._mru = this._keymapInfos;
			this._initialized = true;
			this.onKeyboardLayoutChanged();
		});
	}
}

class UserKeyboardLayout extends Disposable {
	private readonly reloadConfigurationScheduler: RunOnceScheduler;
	protected readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private fileWatcherDisposable: IDisposable = Disposable.None;
	private directoryWatcherDisposable: IDisposable = Disposable.None;

	private _keyboardLayout: KeymapInfo | null;
	get keyboardLayout(): KeymapInfo | null { return this._keyboardLayout; }

	constructor(
		private readonly keyboardLayoutResource: URI,
		private readonly fileService: IFileService
	) {
		super();

		this._keyboardLayout = null;

		this._register(fileService.onFileChanges(e => this.handleFileEvents(e)));
		this.reloadConfigurationScheduler = this._register(new RunOnceScheduler(() => this.reload().then(changed => {
			if (changed) {
				this._onDidChange.fire();
			}
		}), 50));

		this._register(toDisposable(() => {
			this.stopWatchingResource();
			this.stopWatchingDirectory();
		}));
	}

	async initialize(): Promise<void> {
		const exists = await this.fileService.exists(this.keyboardLayoutResource);
		this.onResourceExists(exists);
		await this.reload();
	}

	private async reload(): Promise<boolean> {
		const existing = this._keyboardLayout;
		try {
			const content = await this.fileService.readFile(this.keyboardLayoutResource);
			const value = parse(content.value.toString());
			const layoutInfo = value.layout;
			const mappings = value.rawMapping;
			this._keyboardLayout = KeymapInfo.createKeyboardLayoutFromDebugInfo(layoutInfo, mappings, true);
		} catch (e) {
			this._keyboardLayout = null;
		}

		return existing ? !objects.equals(existing, this._keyboardLayout) : true;
	}

	private watchResource(): void {
		this.fileWatcherDisposable = this.fileService.watch(this.keyboardLayoutResource);
	}

	private watchDirectory(): void {
		const directory = dirname(this.keyboardLayoutResource);
		this.directoryWatcherDisposable = this.fileService.watch(directory);
	}

	private stopWatchingResource(): void {
		this.fileWatcherDisposable.dispose();
		this.fileWatcherDisposable = Disposable.None;
	}

	private stopWatchingDirectory(): void {
		this.directoryWatcherDisposable.dispose();
		this.directoryWatcherDisposable = Disposable.None;
	}

	private async handleFileEvents(event: FileChangesEvent): Promise<void> {
		const events = event.changes;

		let affectedByChanges = false;

		// Find changes that affect the resource
		for (const event of events) {
			affectedByChanges = isEqual(this.keyboardLayoutResource, event.resource);
			if (affectedByChanges) {
				if (event.type === FileChangeType.ADDED) {
					this.onResourceExists(true);
				} else if (event.type === FileChangeType.DELETED) {
					this.onResourceExists(false);
				}
				break;
			}
		}

		if (affectedByChanges) {
			this.reloadConfigurationScheduler.schedule();
		}
	}

	private onResourceExists(exists: boolean): void {
		if (exists) {
			this.stopWatchingDirectory();
			this.watchResource();
		} else {
			this.stopWatchingResource();
			this.watchDirectory();
		}
	}
}

class BrowserKeymapService extends Disposable implements IKeymapService {
	public _serviceBrand: any;

	private readonly _onDidChangeKeyboardMapper = new Emitter<void>();
	public readonly onDidChangeKeyboardMapper: Event<void> = this._onDidChangeKeyboardMapper.event;

	private _userKeyboardLayout: UserKeyboardLayout;

	private readonly layoutChangeListener = this._register(new MutableDisposable());

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@IConfigurationService private configurationService: IConfigurationService,
	) {
		super();
		const keyboardConfig = configurationService.getValue<{ layout: string }>('keyboard');
		const layout = keyboardConfig.layout;

		this.registerKeyboardListener();

		if (layout && layout !== 'autodetect') {
			// set keyboard layout
			BrowserKeyboardMapperFactory.INSTANCE.setKeyboardLayout(layout);
		}

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectedKeys.indexOf('keyboard.layout') >= 0) {
				const keyboardConfig = configurationService.getValue<{ layout: string }>('keyboard');
				const layout = keyboardConfig.layout;

				if (layout === 'autodetect') {
					this.registerKeyboardListener();
					BrowserKeyboardMapperFactory.INSTANCE.onKeyboardLayoutChanged();
				} else {
					BrowserKeyboardMapperFactory.INSTANCE.setKeyboardLayout(layout);
					this.layoutChangeListener.clear();
				}
			}
		}));

		this._userKeyboardLayout = new UserKeyboardLayout(environmentService.keyboardLayoutResource, fileService);
		this._userKeyboardLayout.initialize().then(() => {
			if (this._userKeyboardLayout.keyboardLayout) {
				BrowserKeyboardMapperFactory.INSTANCE.registerKeyboardLayout(this._userKeyboardLayout.keyboardLayout);

				this.setUserKeyboardLayoutIfMatched();
			}
		});

		this._register(this._userKeyboardLayout.onDidChange(() => {
			let userKeyboardLayouts = BrowserKeyboardMapperFactory.INSTANCE.keymapInfos.filter(layout => layout.isUserKeyboardLayout);

			if (userKeyboardLayouts.length) {
				if (this._userKeyboardLayout.keyboardLayout) {
					userKeyboardLayouts[0].update(this._userKeyboardLayout.keyboardLayout);
				} else {
					BrowserKeyboardMapperFactory.INSTANCE.removeKeyboardLayout(userKeyboardLayouts[0]);
				}
			} else {
				if (this._userKeyboardLayout.keyboardLayout) {
					BrowserKeyboardMapperFactory.INSTANCE.registerKeyboardLayout(this._userKeyboardLayout.keyboardLayout);
				}
			}

			this.setUserKeyboardLayoutIfMatched();
		}));
	}

	setUserKeyboardLayoutIfMatched() {
		const keyboardConfig = this.configurationService.getValue<{ layout: string }>('keyboard');
		const layout = keyboardConfig.layout;

		if (layout && this._userKeyboardLayout.keyboardLayout) {
			if (getKeyboardLayoutId(this._userKeyboardLayout.keyboardLayout.layout) === layout && BrowserKeyboardMapperFactory.INSTANCE.activeKeymap) {

				if (!this._userKeyboardLayout.keyboardLayout.equal(BrowserKeyboardMapperFactory.INSTANCE.activeKeymap)) {
					BrowserKeyboardMapperFactory.INSTANCE.setActiveKeymapInfo(this._userKeyboardLayout.keyboardLayout);
				}
			}
		}
	}

	registerKeyboardListener() {
		this.layoutChangeListener.value = BrowserKeyboardMapperFactory.INSTANCE.onDidChangeKeyboardMapper(() => {
			this._onDidChangeKeyboardMapper.fire();
		});
	}

	getKeyboardMapper(dispatchConfig: DispatchConfig): IKeyboardMapper {
		return BrowserKeyboardMapperFactory.INSTANCE.getKeyboardMapper(dispatchConfig);
	}

	public getCurrentKeyboardLayout(): IKeyboardLayoutInfo | null {
		return BrowserKeyboardMapperFactory.INSTANCE.activeKeyboardLayout;
	}

	public getAllKeyboardLayouts(): IKeyboardLayoutInfo[] {
		return BrowserKeyboardMapperFactory.INSTANCE.keyboardLayouts;
	}

	public getRawKeyboardMapping(): IKeyboardMapping | null {
		return BrowserKeyboardMapperFactory.INSTANCE.activeKeyMapping;
	}

	public validateCurrentKeyboardMapping(keyboardEvent: IKeyboardEvent): void {
		BrowserKeyboardMapperFactory.INSTANCE.validateCurrentKeyboardMapping(keyboardEvent);
	}
}

registerSingleton(IKeymapService, BrowserKeymapService, true);

// Configuration
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigExtensions.Configuration);
const keyboardConfiguration: IConfigurationNode = {
	'id': 'keyboard',
	'order': 15,
	'type': 'object',
	'title': nls.localize('keyboardConfigurationTitle', "Keyboard"),
	'overridable': true,
	'properties': {
		'keyboard.layout': {
			'type': 'string',
			'default': 'autodetect',
			'description': nls.localize('keyboard.layout.config', "Control the keyboard layout used in web.")
		}
	}
};

configurationRegistry.registerConfiguration(keyboardConfiguration);