import { Plugin, TFile, TFolder, TAbstractFile, Notice, Keymap, Vault } from 'obsidian';
import { DEFAULT_SETTINGS, ExcludedFolder, FolderNotesSettings, SettingsTab } from './settings';
import FolderNameModal from './modals/folderName';
import { applyTemplate } from './template';
import { Commands } from './commands';
import DeleteConfirmationModal from './modals/deleteConfirmation';
import { FileExplorerWorkspaceLeaf } from './globals';
export default class FolderNotesPlugin extends Plugin {
	observer: MutationObserver;
	folders: TFolder[] = [];
	settings: FolderNotesSettings;
	settingsTab: SettingsTab;
	activeFolderDom: HTMLElement | null;
	activeFileExplorer: FileExplorerWorkspaceLeaf
	async onload() {
		console.log('loading folder notes plugin');
		await this.loadSettings();
		this.settingsTab = new SettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		document.body.classList.add('folder-notes-plugin');
		if (this.settings.hideFolderNote) { document.body.classList.add('hide-folder-note'); }
		if (this.settings.underlineFolder) { document.body.classList.add('folder-note-underline'); }
		new Commands(this.app, this).registerCommands();
		this.observer = new MutationObserver((mutations: MutationRecord[]) => {
			mutations.forEach((rec) => {
				if (rec.type === 'childList') {
					(<Element>rec.target).querySelectorAll('div.nav-folder-title-content')
						.forEach((element: HTMLElement) => {
							if (element.onclick) return;
							element.onclick = (event: MouseEvent) => this.handleFolderClick(event);
						});
				}
			});
		});
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => { this.loadFileClasses()}))
		this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
			if(!(file instanceof TFile)) { return }
			if(file.parent.name !== file.basename) { return }
			this.removeCSSClassToTitleEL(file.parent.path, 'has-folder-note')
		}))
		this.registerEvent(this.app.vault.on('create', (folder: TAbstractFile) => {
			if (!this.app.workspace.layoutReady) return;
			if (!this.settings.autoCreate) return;
			if (!(folder instanceof TFolder)) return;

			const excludedFolder = this.getExcludedFolderByPath(folder.path)
			if (excludedFolder && excludedFolder.disableAutoCreate) return;

			const path = folder.path + '/' + folder.name + '.md';
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file) return;
			this.createFolderNote(path, true, true);
			this.addCSSClassToTitleEL(folder.path, 'has-folder-note')

		}));

		this.registerEvent(this.app.workspace.on('file-open', (openFile: TFile | null) => {
			if(this.activeFolderDom) {
				this.activeFolderDom.removeClass("is-active")
				this.activeFolderDom = null;
			}
			if(!openFile || !openFile.basename) { return }
			if(openFile.basename !== openFile.parent.name) { return }
			this.activeFolderDom = document.querySelector(`[data-path="${openFile.parent.path}"]`)
			this.activeFolderDom && this.activeFolderDom.addClass("is-active")
		}));

		this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (!this.settings.syncFolderName) {
				//cleanup after ourselves
				this.removeCSSClassToTitleEL(file.path, 'has-folder-note')
				this.removeCSSClassToTitleEL(file.path, 'is-folder-note')
				return;
			}
			if (file instanceof TFolder) {
				return this.handleFolderRename(file, oldPath)
			} else if (file instanceof TFile) {
				return this.handleFileRename(file, oldPath)
			}
		}));

		if (!this.app.workspace.layoutReady) {
			this.app.workspace.onLayoutReady(async () => this.loadFileClasses());
		}
	}

	async handleFolderClick(event: MouseEvent) {
		if (!(event.target instanceof HTMLElement)) return;
		event.stopImmediatePropagation();

		const folder = event.target.parentElement?.getAttribute('data-path');
		if(!folder) { return }
		const excludedFolder = this.getExcludedFolderByPath(folder);
		if (excludedFolder && excludedFolder.disableFolderNote) {
			event.target.onclick = null;
			event.target.click();
			return;
		} else if (excludedFolder && excludedFolder.enableCollapsing || this.settings.enableCollapsing) {
			event.target.onclick = null;
			event.target.click();
		}
		const path = folder + '/' + event.target.innerText + '.md';

		if (this.app.vault.getAbstractFileByPath(path)) {
			this.openFolderNote(path);
		} else if (event.altKey || Keymap.isModEvent(event) == 'tab') {
			if ((this.settings.altKey && event.altKey) || (this.settings.ctrlKey && Keymap.isModEvent(event) == 'tab')) {
				await this.createFolderNote(path, true, true);
				this.addCSSClassToTitleEL(folder, 'has-folder-note')
				this.removeCSSClassToTitleEL(folder, 'has-not-folder-note')
			} else {
				event.target.onclick = null;
				event.target.click();
			}
		} else {
			event.target.onclick = null;
			event.target.click();
		}
	}

	handleFolderRename(file: TFolder, oldPath: string) {
		const oldFileName = this.getNameFromPathString(oldPath)
		const oldFilePath = this.getPathFromString(oldPath)
		const folder = this.app.vault.getAbstractFileByPath(file.path);
		if (!folder) return;
		const excludedFolders = this.settings.excludeFolders.filter(
			(excludedFolder) => excludedFolder.path.includes(oldPath)
		);

		excludedFolders.forEach((excludedFolder) => {
			if (excludedFolder.path === oldPath) {
				excludedFolder.path = folder.path;
				return;
			}
			const folders = excludedFolder.path.split('/');
			if (folders.length < 1) {
				folders.push(excludedFolder.path);
			}

			folders[folders.indexOf(oldFileName)] = folder.name;
			excludedFolder.path = folders.join('/');
		});
		this.saveSettings();
		const excludedFolder = this.getExcludedFolderByPath(oldPath)
		if (excludedFolder && excludedFolder.disableSync) return;

		const newPath = folder?.path + '/' + folder?.name + '.md';
		if (!(folder instanceof TFolder)) return;
		const note = this.app.vault.getAbstractFileByPath(oldPath + '/' + oldFileName + '.md');
		if (!note) return;
		(note as TFile).path = folder.path + '/' + oldFileName + '.md';
		this.app.vault.rename(note, newPath);

	}

	handleFileRename(file: TFile, oldPath: string) {
		const oldFileName = this.getNameFromPathString(oldPath)
		const oldFilePath = this.getPathFromString(oldPath)
		const folder = this.app.vault.getAbstractFileByPath(oldFilePath);
		if (!folder) return;
		if (folder.name + '.md' === file.name) return;

		const excludedFolder = this.getExcludedFolderByPath(folder.path)
		if (excludedFolder && excludedFolder.disableSync) return;
		if (oldFileName !== folder.name + '.md') return;
		let newFolderPath = this.getPathFromString(file.path);
		if (newFolderPath.lastIndexOf('/') > 0) {
			newFolderPath = newFolderPath.slice(0, newFolderPath.lastIndexOf('/')) + '/';
		} else {
			newFolderPath = '';
		}
		newFolderPath += file.name.replace('.md', '');
		if (this.app.vault.getAbstractFileByPath(newFolderPath)) {
			this.app.vault.rename(file, oldPath);
			return new Notice('A folder with the same name already exists');
		}
		if (folder instanceof TFolder) {
			let newPath = file.basename;
			if (folder.path.indexOf('/') >= 0) {
				newPath = this.getPathFromString(folder.path) + '/' + newPath;
			}
			this.app.vault.rename(folder, newPath);
		}
	}

	async createFolderNote(path: string, openFile: boolean, useModal?: boolean) {
		const leaf = this.app.workspace.getLeaf(false);
		const file = await this.app.vault.create(path, '');
		if (openFile) {
			await leaf.openFile(file);
		}
		if (file) {
			applyTemplate(this, file, this.settings.templatePath);
		}
		this.addCSSClassToTitleEL(path, 'is-folder-note')

		if (!this.settings.autoCreate) return;
		if (!useModal) return;
		const folder = this.app.vault.getAbstractFileByPath(this.getPathFromString(path));
		if (!(folder instanceof TFolder)) return;
		const modal = new FolderNameModal(this.app, this, folder);
		modal.open();
	}

	async openFolderNote(path: string) {
		const leaf = this.app.workspace.getLeaf(false);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await leaf.openFile(file);
		}
	}

	async deleteFolderNote(file: TFile) {
		if (this.settings.showDeleteConfirmation) {
			return new DeleteConfirmationModal(this.app, this, file).open();
		}

		await this.app.vault.delete(file);
	}

	getNameFromPathString(path: string): string {
		return path.substring(path.lastIndexOf('/' || '\\') >= 0 ? path.lastIndexOf('/' || '\\') + 1 : 0)
	}

	getPathFromString(path: string): string {
		const subString = path.lastIndexOf('/' || '\\') >= 0 ? path.lastIndexOf('/') : path.length;
		return path.substring(0, subString)
	}

	getExcludedFolderByPath(path: string): ExcludedFolder | undefined {
		return this.settings.excludeFolders.find((excludedFolder) => {
			if(excludedFolder.path === path) { return true }
			if(!excludedFolder.subFolders) { return false }
			return excludedFolder.path === this.getPathFromString(path)
		})
	}

	getFileExplorer() {
		return this.app.workspace.getLeavesOfType('file-explorer')[0] as FileExplorerWorkspaceLeaf;
	}

	getFileExplorerView() {
		return this.getFileExplorer().view;
	}

	addCSSClassToTitleEL(path: string, cssClass: string) {
		const fileExplorer = this.getFileExplorer();
		if(!fileExplorer) { return }
		const fileExplorerItem = fileExplorer.view.fileItems[path]
		if(fileExplorerItem) { fileExplorerItem.titleEl.addClass(cssClass)}
	}

	removeCSSClassToTitleEL(path: string, cssClass: string) {
		const fileExplorerView = this.getFileExplorerView();
		if(!fileExplorerView) { return }
		const fileExplorerItem = fileExplorerView.fileItems[path]
		if(fileExplorerItem) { fileExplorerItem.titleEl.removeClass(cssClass)}
	}

	loadFileClasses() {
		if(this.activeFileExplorer === this.getFileExplorer()) { return }
		this.activeFileExplorer = this.getFileExplorer();
		this.app.vault.getMarkdownFiles().forEach(file => {
			if(file.basename !== file.parent.name) { return }
			this.addCSSClassToTitleEL(file.parent.path, 'has-folder-note')
			this.addCSSClassToTitleEL(file.path, 'is-folder-note')
		})
	}

	onunload() {
		console.log('unloading folder notes plugin');
		this.observer.disconnect();
		document.body.classList.remove('folder-notes-plugin');
		document.body.classList.remove('hide-folder-note');
		document.body.classList.remove('folder-note-underline');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
