import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import {
	getOAuthProviders,
	getOpenAICodexLoginMethods,
	loginLiteLLM,
	type OAuthPrompt,
	type OAuthProvider,
} from "@f5-sales-demo/pi-ai";
import type { Component } from "@f5-sales-demo/pi-tui";
import { Loader, Spacer, Text } from "@f5-sales-demo/pi-tui";
import { getAgentDbPath, getAgentDir, getConfigDirName, getProjectDir } from "@f5-sales-demo/pi-utils";
import { invalidate as invalidateFsCache } from "../../capability/fs";
import { probeLiteLLMConnection, readLiteLLMConfig } from "../../config/auto-config";
import { settings } from "../../config/settings";
import {
	DEFAULT_VLLM_BASE_URL,
	normalizeVllmBaseUrl,
	probeVllmConnection,
	readVllmConfig,
} from "../../config/vllm-config";
import { DebugSelectorComponent } from "../../debug";
import { disableProvider, enableProvider } from "../../discovery";
import { clearXcshPluginRootsCache, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import type { UserPromptKind } from "../../extensibility/extensions/types";
import {
	formatMarketplaceRefreshWarning,
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import {
	getAvailableThemes,
	getSymbolTheme,
	previewTheme,
	setColorBlindMode,
	setSymbolPreset,
	setTheme,
	theme,
} from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { type SessionInfo, SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { isSearchProviderPreference, setPreferredImageProvider, setPreferredSearchProvider } from "../../tools";
import { applyHyperlinkSetting } from "../../tui/hyperlink";
import { copyToClipboard, copyToClipboardWithResult } from "../../utils/clipboard";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { AgentDashboard } from "../components/agent-dashboard";
import { AssistantMessageComponent } from "../components/assistant-message";
import { presentAuthLink, presentDeviceCode } from "../components/auth-link-presenter";
import { CopySelectorComponent } from "../components/copy-selector";
import { ExtensionDashboard } from "../components/extensions";
import { GutterBlock } from "../components/gutter-block";
import { HistorySearchComponent } from "../components/history-search";
import { HookSelectorComponent } from "../components/hook-selector";
import { LiteLLMModelSelectorComponent } from "../components/litellm-model-selector";
import { createLoginPromptInput } from "../components/login-prompt-input";
import { ModelSelectorComponent } from "../components/model-selector";
import { OAuthSelectorComponent } from "../components/oauth-selector";
import { PluginSelectorComponent } from "../components/plugin-selector";
import { PluginDashboard } from "../components/plugins";
import { SessionObserverOverlayComponent } from "../components/session-observer-overlay";
import { SessionSelectorComponent } from "../components/session-selector";
import { SettingsSelectorComponent } from "../components/settings-selector";
import { getPreset } from "../components/status-line/presets";
import { ToolExecutionComponent } from "../components/tool-execution";
import { TreeSelectorComponent } from "../components/tree-selector";
import { UserMessageSelectorComponent } from "../components/user-message-selector";
import { VllmModelSelectorComponent } from "../components/vllm-model-selector";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { runEnterpriseOAuthLoginFlow } from "./enterprise-oauth-login-flow";
import {
	captureEnterpriseOAuthLoginState,
	restoreEnterpriseOAuthLoginState,
} from "./enterprise-oauth-login-transaction";
import { type LoginRecoveryAction, type LoginRecoveryRequest, runLiteLLMLoginFlow } from "./litellm-login-flow";
import { commitLiteLLMLogin } from "./litellm-login-transaction";
import {
	applyModelAfterLogin,
	applyOAuthLoginModel,
	formatLoginThinkingState,
	GOOGLE_ANTIGRAVITY_LOGIN_MODEL_CHOICE,
	GOOGLE_VERTEX_LOGIN_MODEL_CHOICE,
	LITELLM_LOGIN_MODEL_CHOICES,
	type LiteLLMLoginModelChoice,
	type LoginModelChoice,
} from "./login-model";
import { applyModelSelection } from "./model-selection";
import {
	defaultVertexLoginRuntime,
	detectVertexProject,
	isHeadlessTerminal,
	validateVertexLogin,
	vertexFailureGuidance,
} from "./vertex-login-flow";
import { runVllmLoginFlow } from "./vllm-login-flow";
import { commitVllmLogin } from "./vllm-login-transaction";

const CALLBACK_SERVER_PROVIDERS = new Set<OAuthProvider>([
	"anthropic",
	"gitlab-duo",
	"google-gemini-cli",
	"google-antigravity",
	"google-antigravity-enterprise",
]);

const MANUAL_LOGIN_TIP = "Tip: You can complete pairing with /login <redirect URL>.";
const VERTEX_MANUAL_LOGIN_TIP = "Tip: After browser sign-in, complete pairing with /login <authorization code>.";

class LoginPromptCancelled extends Error {}

export class SelectorController {
	constructor(private ctx: InteractiveModeContext) {}

	#launchHttpUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
		if (typeof this.ctx.openHttpUrl === "function") return this.ctx.openHttpUrl(url);
		this.ctx.openInBrowser(url);
		return Promise.resolve({ ok: true });
	}

	#emitPromptSignal(type: "user_prompt_start" | "user_prompt_end", kind: UserPromptKind): void {
		this.ctx.session.extensionRunner?.emit({ type, kind }).catch(() => {});
	}

	#beginPromptSignal(kind: UserPromptKind): () => void {
		let open = true;
		this.#emitPromptSignal("user_prompt_start", kind);
		return () => {
			if (!open) return;
			open = false;
			this.#emitPromptSignal("user_prompt_end", kind);
		};
	}

	async #refreshOAuthProviderAuthState(): Promise<void> {
		const oauthProviders = getOAuthProviders().filter(provider => !provider.loginOnly);
		await Promise.all(
			oauthProviders.map(provider =>
				this.ctx.session.modelRegistry
					.getApiKeyForProvider(provider.id, this.ctx.session.sessionId)
					.catch(() => undefined),
			),
		);
	}
	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	showSelector(
		create: (done: () => void) => { component: Component; focus: Component },
		promptKind?: UserPromptKind,
	): void {
		let endPrompt: (() => void) | undefined;
		const done = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
			endPrompt?.();
		};
		const { component, focus } = create(done);
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(component);
		this.ctx.ui.setFocus(focus);
		this.ctx.ui.requestRender();
		if (promptKind) endPrompt = this.#beginPromptSignal(promptKind);
	}

	showSettingsSelector(): void {
		getAvailableThemes().then(availableThemes => {
			this.showSelector(done => {
				const selector = new SettingsSelectorComponent(
					{
						availableThinkingLevels: [...this.ctx.session.getAvailableThinkingLevels()],
						thinkingLevel: this.ctx.session.thinkingLevel,
						availableThemes,
						cwd: getProjectDir(),
					},
					{
						onChange: (id, value) => this.handleSettingChange(id, value),
						onThemePreview: async themeName => {
							const result = await previewTheme(themeName);
							if (result.success) {
								this.ctx.statusLine.invalidate();
								this.ctx.updateEditorTopBorder();
								this.ctx.ui.invalidate();
								this.ctx.ui.requestRender();
							}
						},
						onStatusLinePreview: previewSettings => {
							// Update status line with preview settings
							this.ctx.statusLine.updateSettings({
								preset: settings.get("statusLine.preset"),
								leftSegments: settings.get("statusLine.leftSegments"),
								rightSegments: settings.get("statusLine.rightSegments"),
								separator: settings.get("statusLine.separator"),
								showHookStatus: settings.get("statusLine.showHookStatus"),
								...previewSettings,
							});
							this.ctx.updateEditorTopBorder();
							this.ctx.ui.requestRender();
						},
						getStatusLinePreview: () => {
							// Return the rendered status line for inline preview
							const availableWidth = this.ctx.editor.getTopBorderAvailableWidth(this.ctx.ui.terminal.columns);
							return this.ctx.statusLine.getTopBorder(availableWidth).content;
						},
						onPluginsChanged: () => {
							this.ctx.ui.requestRender();
						},
						onCancel: () => {
							done();
							// Restore status line to saved settings
							this.ctx.statusLine.updateSettings({
								preset: settings.get("statusLine.preset"),
								leftSegments: settings.get("statusLine.leftSegments"),
								rightSegments: settings.get("statusLine.rightSegments"),
								separator: settings.get("statusLine.separator"),
								showHookStatus: settings.get("statusLine.showHookStatus"),
							});
							this.ctx.updateEditorTopBorder();
							this.ctx.ui.requestRender();
						},
					},
				);
				return { component: selector, focus: selector };
			});
		});
	}

	showHistorySearch(): void {
		const historyStorage = this.ctx.historyStorage;
		if (!historyStorage) return;

		this.showSelector(done => {
			const component = new HistorySearchComponent(
				historyStorage,
				prompt => {
					done();
					this.ctx.editor.setText(prompt);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component, focus: component };
		});
	}

	showCopySelector(): void {
		const tail = this.ctx.session.sessionManager.getMessageBranchTail(600);
		const loadAllEntries = () =>
			this.ctx.session.sessionManager
				.getBranch()
				.filter(
					(entry): entry is import("../../session/session-manager").SessionMessageEntry =>
						entry.type === "message",
				);
		let closed = false;
		let overlay: ReturnType<typeof this.ctx.ui.showOverlay>;
		const selector = new CopySelectorComponent(tail.entries, {
			requestRender: () => this.ctx.ui.requestRender(),
			viewportRows: () => this.ctx.ui.terminal.rows,
			initialHistoryTruncated: tail.truncated,
			loadAllEntries,
			onCancel: () => close(),
			onPick: async (content, label) => {
				try {
					const result = await copyToClipboardWithResult(content);
					if (!result.ok) {
						this.ctx.showError(`Clipboard failed: ${result.error}. Press Enter to retry.`);
						return;
					}
					this.ctx.showStatus(`Copied ${label}.`);
					close();
				} catch (error) {
					this.ctx.showError(`Clipboard failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
			onOpen: (href, label) => {
				void this.ctx.openHttpUrl(href).then(result => {
					if (result.ok) this.ctx.showStatus(`Opened ${label}.`);
					else this.ctx.showError(`Could not open link: ${result.error}`);
				});
			},
		});
		const close = () => {
			if (closed) return;
			closed = true;
			selector.dispose();
			overlay.hide();
			this.ctx.ui.requestRender();
		};
		if (selector.targetCount === 0 && !selector.canLoadEarlier) {
			this.ctx.showWarning("No transcript content is available to copy.");
			selector.dispose();
			return;
		}
		overlay = this.ctx.ui.showOverlay(selector, { fullscreen: true, mouseTracking: true });
	}

	/**
	 * Show the Extension Control Center dashboard.
	 * Replaces /status with a unified view of all providers and extensions.
	 */
	async showExtensionsDashboard(): Promise<void> {
		const dashboard = await ExtensionDashboard.create(
			getProjectDir(),
			this.ctx.settings,
			() => this.ctx.ui.terminal.rows,
		);
		const overlay = this.ctx.ui.showOverlay(dashboard, {
			fullscreen: true,
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		dashboard.onClose = () => {
			overlay.hide();
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		dashboard.onRequestRender = () => this.ctx.ui.requestRender();
		this.ctx.ui.setFocus(dashboard);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show the Agent Control Center dashboard.
	 */
	async showAgentsDashboard(): Promise<void> {
		const activeModel = this.ctx.session.model;
		const activeModelPattern = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
		const defaultModelPattern = this.ctx.settings.getModelRole("default");
		const dashboard = await AgentDashboard.create(getProjectDir(), this.ctx.settings, this.ctx.ui.terminal.rows, {
			modelRegistry: this.ctx.session.modelRegistry,
			activeModelPattern,
			defaultModelPattern,
		});
		this.showSelector(done => {
			dashboard.onClose = () => {
				done();
				this.ctx.ui.requestRender();
			};
			dashboard.onRequestRender = () => {
				this.ctx.ui.requestRender();
			};
			return { component: dashboard, focus: dashboard };
		});
	}

	async showPluginDashboard(): Promise<void> {
		const dashboard = await PluginDashboard.create(getProjectDir(), this.ctx.ui.terminal.rows);
		this.showSelector(done => {
			dashboard.onClose = () => {
				done();
				this.ctx.ui.requestRender();
			};
			dashboard.onRequestRender = () => {
				this.ctx.ui.requestRender();
			};
			return { component: dashboard, focus: dashboard };
		});
	}

	/**
	 * Handle setting changes from the settings selector.
	 * Most settings are saved directly via SettingsManager in the definitions.
	 * This handles side effects and session-specific settings.
	 */
	handleSettingChange(id: string, value: unknown): void {
		// Discovery provider toggles
		if (id.startsWith("discovery.")) {
			const providerId = id.replace("discovery.", "");
			if (value) {
				enableProvider(providerId);
			} else {
				disableProvider(providerId);
			}
			return;
		}

		switch (id) {
			// Session-managed settings (not in SettingsManager)
			case "autoCompact":
				this.ctx.session.setAutoCompactionEnabled(value as boolean);
				this.ctx.statusLine.setAutoCompactEnabled(value as boolean);
				break;
			case "steeringMode":
				this.ctx.session.setSteeringMode(value as "all" | "one-at-a-time");
				break;
			case "followUpMode":
				this.ctx.session.setFollowUpMode(value as "all" | "one-at-a-time");
				break;
			case "interruptMode":
				this.ctx.session.setInterruptMode(value as "immediate" | "wait");
				break;
			case "thinkingLevel":
			case "defaultThinkingLevel":
				this.ctx.session.setThinkingLevel(value as ThinkingLevel, true);
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				break;

			case "clearOnShrink":
				this.ctx.ui.setClearOnShrink(value as boolean);
				break;
			case "tui.hyperlinks":
				applyHyperlinkSetting(value);
				this.ctx.statusLine.invalidate();
				this.ctx.chatContainer.invalidate();
				this.ctx.ui.invalidate();
				this.ctx.ui.requestRender();
				break;

			case "autocompleteMaxVisible":
				this.ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value));
				break;

			// Settings with UI side effects
			case "showImages":
				for (const child of this.ctx.chatContainer.children) {
					const unwrapped = child instanceof GutterBlock ? child.child : child;
					if (unwrapped instanceof ToolExecutionComponent) {
						unwrapped.setShowImages(value as boolean);
					}
				}
				break;
			case "hideThinking":
				this.ctx.hideThinkingBlock = value as boolean;
				for (const child of this.ctx.chatContainer.children) {
					const unwrapped = child instanceof GutterBlock ? child.child : child;
					if (unwrapped instanceof AssistantMessageComponent) {
						unwrapped.setHideThinkingBlock(value as boolean);
					}
				}
				this.ctx.chatContainer.clear();
				this.ctx.rebuildChatFromMessages();
				break;
			case "theme": {
				setTheme(value as string, true).then(result => {
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
					this.ctx.ui.invalidate();
					if (!result.success) {
						this.ctx.showError(`Failed to load theme "${value}": ${result.error}\nFell back to dark theme.`);
					}
				});
				break;
			}
			case "symbolPreset": {
				setSymbolPreset(value as "unicode" | "nerd" | "ascii").then(() => {
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorTopBorder();
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "colorBlindMode": {
				setColorBlindMode(value === "true" || value === true).then(() => {
					this.ctx.ui.invalidate();
				});
				break;
			}
			case "temperature": {
				const temp = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.temperature = temp >= 0 ? temp : undefined;
				break;
			}
			case "topP": {
				const topP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topP = topP >= 0 ? topP : undefined;
				break;
			}
			case "topK": {
				const topK = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.topK = topK >= 0 ? topK : undefined;
				break;
			}
			case "minP": {
				const minP = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.minP = minP >= 0 ? minP : undefined;
				break;
			}
			case "presencePenalty": {
				const presencePenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.presencePenalty = presencePenalty >= 0 ? presencePenalty : undefined;
				break;
			}
			case "repetitionPenalty": {
				const repetitionPenalty = typeof value === "number" ? value : Number(value);
				this.ctx.session.agent.repetitionPenalty = repetitionPenalty >= 0 ? repetitionPenalty : undefined;
				break;
			}
			case "statusLinePreset":
			case "statusLineSeparator":
			case "statusLineShowHooks":
			case "statusLineSegments":
			case "statusLineModelThinking":
			case "statusLinePathAbbreviate":
			case "statusLinePathMaxLength":
			case "statusLinePathStripWorkPrefix":
			case "statusLineGitShowBranch":
			case "statusLineGitShowStaged":
			case "statusLineGitShowUnstaged":
			case "statusLineGitShowUntracked":
			case "statusLineTimeFormat":
			case "statusLineTimeShowSeconds": {
				// When selecting a non-custom preset, sync the preset's separator
				// to the store so #resolveSettings picks it up correctly.
				if (id === "statusLinePreset" && value !== "custom") {
					const presetDef = getPreset(value as Parameters<typeof getPreset>[0]);
					if (presetDef.separator) {
						settings.set("statusLine.separator", presetDef.separator);
					}
				}
				const statusLineSettings = {
					preset: settings.get("statusLine.preset"),
					leftSegments: settings.get("statusLine.leftSegments"),
					rightSegments: settings.get("statusLine.rightSegments"),
					separator: settings.get("statusLine.separator"),
					showHookStatus: settings.get("statusLine.showHookStatus"),
					segmentOptions: settings.get("statusLine.segmentOptions"),
				};
				this.ctx.statusLine.updateSettings(statusLineSettings);
				this.ctx.updateEditorTopBorder();
				this.ctx.ui.requestRender();
				break;
			}

			// Provider settings - update runtime preferences
			case "providers.webSearch":
				if (typeof value === "string" && isSearchProviderPreference(value)) {
					setPreferredSearchProvider(value);
				}
				break;
			case "providers.image":
				if (value === "auto" || value === "gemini" || value === "openrouter") {
					setPreferredImageProvider(value);
				}
				break;

			// MCP update injection - live subscribe/unsubscribe
			case "mcp.notifications":
				this.ctx.mcpManager?.setNotificationsEnabled(value as boolean);
				break;

			// All other settings are handled by the definitions (get/set on SettingsManager)
			// No additional side effects needed
		}
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.showSelector(done => {
			const selector = new ModelSelectorComponent(
				this.ctx.ui,
				this.ctx.session.model,
				this.ctx.settings,
				this.ctx.session.modelRegistry,
				this.ctx.session.scopedModels,
				async selection => {
					await applyModelSelection(this.ctx.session, selection);
					this.ctx.statusLine.invalidate();
					this.ctx.updateEditorBorderColor();
					const scope =
						selection.scope === "conversation"
							? "This conversation"
							: selection.scope === "default"
								? "Saved default"
								: `Role ${selection.role}`;
					this.ctx.showStatus(`${scope}: ${selection.selector} · reasoning ${selection.thinkingLevel}`);
					if (selection.scope !== "role") done();
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				{
					...options,
					currentThinkingLevel: this.ctx.session.thinkingLevel,
					onLogin: () => {
						done();
						void this.showOAuthSelector("login");
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	async #showLiteLLMLoginModelSelector(
		choices: readonly LiteLLMLoginModelChoice[],
	): Promise<LiteLLMLoginModelChoice | null> {
		const available = new Set(choices.map(choice => choice.modelId));
		const unavailable = LITELLM_LOGIN_MODEL_CHOICES.filter(choice => !available.has(choice.modelId));

		if (unavailable.length > 0) {
			this.ctx.chatContainer.addChild(
				new Text(
					theme.fg(
						"warning",
						`Unavailable from this proxy: ${unavailable.map(choice => choice.label).join(", ")}`,
					),
					1,
					0,
				),
			);
		}

		const { promise, resolve } = Promise.withResolvers<LiteLLMLoginModelChoice | null>();
		this.showSelector(done => {
			const selector = new LiteLLMModelSelectorComponent(
				choices,
				choice => {
					done();
					resolve(choice);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					resolve(null);
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});

		return promise;
	}

	async #showVllmLoginModelSelector(choices: readonly LoginModelChoice[]): Promise<LoginModelChoice | null> {
		const { promise, resolve } = Promise.withResolvers<LoginModelChoice | null>();
		this.showSelector(done => {
			const selector = new VllmModelSelectorComponent(
				choices,
				choice => {
					done();
					resolve(choice);
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					resolve(null);
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
		return promise;
	}

	async #promptLoginValue(prompt: OAuthPrompt): Promise<string> {
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new Text(theme.fg("text", prompt.message), 1, 0));
		if (prompt.placeholder) {
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", prompt.placeholder), 1, 0));
		}
		this.ctx.ui.requestRender();
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const input = createLoginPromptInput(prompt);
		const closeInput = () => {
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		input.onSubmit = () => {
			const value = input.getValue();
			closeInput();
			resolve(value);
		};
		input.onEscape = () => {
			closeInput();
			reject(new LoginPromptCancelled());
		};
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(input);
		this.ctx.ui.setFocus(input);
		this.ctx.ui.requestRender();
		const endPrompt = this.#beginPromptSignal("input");
		return promise.finally(endPrompt);
	}

	async #showLoginRecovery(
		request: LoginRecoveryRequest | { stage: string; error: string; canEdit: boolean },
		flowLabel = "LiteLLM",
		editLabel = "Edit connection",
	): Promise<LoginRecoveryAction> {
		const options = request.canEdit ? ["Retry", editLabel, "Cancel"] : ["Retry", "Cancel"];
		const { promise, resolve } = Promise.withResolvers<LoginRecoveryAction>();
		this.showSelector(done => {
			const selector = new HookSelectorComponent(
				`${flowLabel} ${request.stage} failed\n\n${request.error}`,
				options,
				option => {
					done();
					resolve(option === "Retry" ? "retry" : option === editLabel ? "edit" : "cancel");
					this.ctx.ui.requestRender();
				},
				() => {
					done();
					resolve("cancel");
					this.ctx.ui.requestRender();
				},
				{ maxVisible: 3, helpText: "up/down navigate  enter select  esc cancel" },
			);
			return { component: selector, focus: selector };
		});
		return promise;
	}

	async showPluginSelector(mode: "install" | "uninstall" = "install"): Promise<void> {
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: (extraPaths?: readonly string[]) => {
				const home = os.homedir();
				invalidateFsCache(path.join(home, getConfigDirName(), "plugins", "installed_plugins.json"));
				for (const p of extraPaths ?? []) invalidateFsCache(p);
				clearXcshPluginRootsCache();
			},
		});

		const refresh = mode === "install" ? await mgr.refreshMarketplaces() : undefined;
		const refreshWarning = refresh ? formatMarketplaceRefreshWarning(refresh) : undefined;
		if (refreshWarning) this.ctx.showStatus(refreshWarning);
		const [marketplaces, installed] = await Promise.all([mgr.listMarketplaces(), mgr.listInstalledPlugins()]);
		const installedIds = new Set(installed.map(p => p.id));

		if (mode === "uninstall") {
			// Show only installed plugins for uninstall
			const items = installed.map(p => {
				const entry = p.entries[0];
				const atIdx = p.id.lastIndexOf("@");
				const pluginName = atIdx > 0 ? p.id.slice(0, atIdx) : p.id;
				const mkt = atIdx > 0 ? p.id.slice(atIdx + 1) : "unknown";
				return {
					plugin: { name: pluginName, version: entry?.version, description: undefined as string | undefined },
					marketplace: mkt,
					scope: p.scope,
				};
			});
			this.showSelector(done => {
				const selector = new PluginSelectorComponent(marketplaces.length, items, new Set(), {
					onSelect: async (name, marketplace, scope) => {
						done();
						const pluginId = `${name}@${marketplace}`;
						this.ctx.showStatus(`Uninstalling ${pluginId}...`);
						this.ctx.ui.requestRender();
						try {
							await mgr.uninstallPlugin(pluginId, scope);
							this.ctx.showStatus(`Uninstalled ${pluginId}`);
						} catch (err) {
							this.ctx.showStatus(`Uninstall failed: ${err}`);
						}
						this.ctx.ui.requestRender();
					},
					onCancel: () => {
						done();
						this.ctx.ui.requestRender();
					},
				});
				return { component: selector, focus: selector.getSelectList() };
			});
			return;
		}

		// Install mode: show all available plugins from all marketplaces
		const allPlugins: Array<{
			plugin: { name: string; version?: string; description?: string };
			marketplace: string;
		}> = [];
		for (const mkt of marketplaces) {
			let plugins: Awaited<ReturnType<typeof mgr.listAvailablePlugins>>;
			try {
				plugins = await mgr.listAvailablePlugins(mkt.name);
			} catch (error) {
				this.ctx.showStatus(
					`${refreshWarning ? `${refreshWarning}\n` : ""}Marketplace ${mkt.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			for (const plugin of plugins) {
				allPlugins.push({ plugin, marketplace: mkt.name });
			}
		}

		this.showSelector(done => {
			const selector = new PluginSelectorComponent(marketplaces.length, allPlugins, installedIds, {
				onSelect: async (name, marketplace) => {
					done();
					this.ctx.showStatus(`Installing ${name} from ${marketplace}...`);
					this.ctx.ui.requestRender();
					try {
						const installRefresh = await mgr.refreshMarketplaces([marketplace]);
						const installWarning = formatMarketplaceRefreshWarning(installRefresh);
						const force = installedIds.has(`${name}@${marketplace}`);
						await mgr.installPlugin(name, marketplace, { force });
						this.ctx.showStatus(
							`${installWarning ? `${installWarning}\n` : ""}Installed ${name} from ${marketplace}`,
						);
					} catch (err) {
						this.ctx.showStatus(`Install failed: ${err}`);
					}
					this.ctx.ui.requestRender();
				},
				onCancel: () => {
					done();
					this.ctx.ui.requestRender();
				},
			});
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	showUserMessageSelector(): void {
		const userMessages = this.ctx.session.getUserMessagesForBranching();

		if (userMessages.length === 0) {
			this.ctx.showStatus("No messages to branch from");
			return;
		}

		this.showSelector(done => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map(m => ({ id: m.entryId, text: m.text })),
				async entryId => {
					const result = await this.ctx.session.branch(entryId);
					if (result.cancelled) {
						// Hook cancelled the branch
						done();
						this.ctx.ui.requestRender();
						return;
					}

					this.ctx.chatContainer.clear();
					this.ctx.renderInitialMessages();
					this.ctx.editor.setText(result.selectedText);
					done();
					this.ctx.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	showTreeSelector(): void {
		const tree = this.ctx.sessionManager.getTree();
		const realLeafId = this.ctx.sessionManager.getLeafId();

		if (tree.length === 0) {
			this.ctx.showStatus("No entries in session");
			return;
		}

		this.showSelector(done => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ctx.ui.terminal.rows,
				async entryId => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.ctx.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					const branchSummariesEnabled = settings.get("branchSummary.enabled");

					while (branchSummariesEnabled) {
						const summaryChoice = await this.ctx.showHookSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector
							this.showTreeSelector();
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await this.ctx.showHookEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.ctx.editor.onEscape;

					if (wantsSummary) {
						this.ctx.editor.onEscape = () => {
							this.ctx.session.abortBranchSummary();
						};
						this.ctx.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ctx.ui,
							spinner => theme.fg("accent", spinner),
							text => theme.fg("muted", text),
							"Summarizing branch... (esc to cancel)",
							getSymbolTheme().spinnerFrames,
						);
						this.ctx.statusContainer.addChild(summaryLoader);
						this.ctx.ui.requestRender();
					}

					try {
						const result = await this.ctx.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector
							this.ctx.showStatus("Branch summarization cancelled");
							this.showTreeSelector();
							return;
						}
						if (result.cancelled) {
							this.ctx.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.ctx.chatContainer.clear();
						this.ctx.renderInitialMessages();
						await this.ctx.reloadTodos();
						if (result.editorText && !this.ctx.editor.getText().trim()) {
							this.ctx.editor.setText(result.editorText);
						}
						this.ctx.showStatus("Navigated to selected point");
					} catch (error) {
						this.ctx.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.ctx.statusContainer.clear();
						}
						this.ctx.editor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ctx.ui.requestRender();
				},
				(entryId, label) => {
					this.ctx.sessionManager.appendLabelChange(entryId, label);
					this.ctx.ui.requestRender();
				},
				settings.get("treeFilterMode"),
			);
			return { component: selector, focus: selector };
		});
	}

	async showSessionSelector(): Promise<void> {
		const sessions = await SessionManager.list(
			this.ctx.sessionManager.getCwd(),
			this.ctx.sessionManager.getSessionDir(),
		);
		let hideOverlay = () => {};
		const done = () => {
			hideOverlay();
			this.ctx.ui.setFocus(this.ctx.editor);
			this.ctx.ui.requestRender();
		};
		const selector = new SessionSelectorComponent(
			sessions,
			async sessionPath => {
				done();
				await this.handleResumeSession(sessionPath);
			},
			done,
			() => {
				done();
				void this.ctx.shutdown();
			},
			async (session: SessionInfo) => {
				if (!(await this.#detachActiveSessionBeforeDeletion(session.path))) {
					return false;
				}
				const storage = new FileSessionStorage();
				try {
					await storage.deleteSessionWithArtifacts(session.path);
					return true;
				} catch (err) {
					throw new Error(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`, {
						cause: err,
					});
				}
			},
			{ getTerminalRows: () => this.ctx.ui.terminal.rows },
		);
		selector.setOnRequestRender(() => this.ctx.ui.requestRender());
		const overlay = this.ctx.ui.showOverlay(selector, {
			fullscreen: true,
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		hideOverlay = () => overlay.hide();
		this.ctx.ui.setFocus(selector);
	}

	#clearTransientSessionUi(): void {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.clear();
		this.ctx.pendingMessagesContainer.clear();
		this.ctx.compactionQueuedMessages = [];
		this.ctx.streamingComponent = undefined;
		this.ctx.streamingMessage = undefined;
		this.ctx.pendingTools.clear();
	}

	#refreshSessionTerminalTitle(): void {
		const sessionManager = this.ctx.sessionManager as {
			getSessionName?: () => string | undefined;
			getCwd: () => string;
			titleSource?: "auto" | "user" | undefined;
		};
		setSessionTerminalTitle(sessionManager.getSessionName?.(), sessionManager.getCwd(), sessionManager.titleSource);
	}

	async #detachActiveSessionBeforeDeletion(sessionPath: string): Promise<boolean> {
		const currentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (currentSessionFile !== sessionPath) {
			return true;
		}

		const detached = await this.ctx.session.newSession();
		if (!detached) {
			return false;
		}
		this.#refreshSessionTerminalTitle();

		this.#clearTransientSessionUi();
		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.setSessionStartTime(Date.now());
		this.ctx.updateEditorTopBorder();
		this.ctx.updateEditorBorderColor();
		this.ctx.renderInitialMessages();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();
		return true;
	}

	async handleResumeSession(sessionPath: string): Promise<void> {
		this.#clearTransientSessionUi();

		// Switch session via AgentSession (emits hook and tool session events)
		await this.ctx.session.switchSession(sessionPath);
		this.#refreshSessionTerminalTitle();
		this.ctx.updateEditorBorderColor();

		// Clear and re-render the chat
		this.ctx.chatContainer.clear();
		this.ctx.renderInitialMessages();
		await this.ctx.reloadTodos();
		this.ctx.showStatus("Resumed session");
	}

	async handleSessionDeleteCommand(): Promise<void> {
		const sessionFile = this.ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			this.ctx.showError("No session file to delete (in-memory session)");
			return;
		}

		// Check if session file exists (may not exist for brand new sessions)
		const storage = new FileSessionStorage();
		const fileExists = await storage.exists(sessionFile);
		if (!fileExists) {
			this.ctx.showError("Session has not been saved yet");
			return;
		}

		const confirmed = await this.ctx.showHookConfirm(
			"Delete Session",
			"This will permanently delete the current session.\nYou will be returned to the session selector.",
		);

		if (!confirmed) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		if (!(await this.#detachActiveSessionBeforeDeletion(sessionFile))) {
			this.ctx.showStatus("Delete cancelled");
			return;
		}

		// Delete the session file and artifacts directory
		await storage.deleteSessionWithArtifacts(sessionFile);

		// Show session selector
		this.ctx.showStatus("Session deleted");
		await this.showSessionSelector();
	}

	async #handleLiteLLMLogin(): Promise<void> {
		this.ctx.showStatus("Configuring LiteLLM proxy…");
		const modelsPath = path.join(getAgentDir(), "models.yml");
		const configPath = path.join(path.dirname(modelsPath), "config.yml");
		let defaults = readLiteLLMConfig(modelsPath);

		try {
			const flowResult = await runLiteLLMLoginFlow({
				collectCredentials: async () => {
					try {
						const credentials = await loginLiteLLM({
							defaults,
							onPrompt: async prompt => {
								this.ctx.chatContainer.addChild(new Spacer(1));
								this.ctx.chatContainer.addChild(new Text(theme.fg("text", prompt.message), 1, 0));
								if (prompt.placeholder) {
									this.ctx.chatContainer.addChild(
										new Text(theme.fg("dim", `e.g., ${prompt.placeholder}`), 1, 0),
									);
								}
								this.ctx.ui.requestRender();

								const { promise, resolve, reject } = Promise.withResolvers<string>();
								const codeInput = createLoginPromptInput(prompt);
								const closeInput = () => {
									this.ctx.editorContainer.clear();
									this.ctx.editorContainer.addChild(this.ctx.editor);
									this.ctx.ui.setFocus(this.ctx.editor);
								};
								codeInput.onSubmit = () => {
									const value = codeInput.getValue();
									closeInput();
									resolve(value);
								};
								codeInput.onEscape = () => {
									closeInput();
									reject(new LoginPromptCancelled());
								};
								this.ctx.editorContainer.clear();
								this.ctx.editorContainer.addChild(codeInput);
								this.ctx.ui.setFocus(codeInput);
								this.ctx.ui.requestRender();
								return promise;
							},
						});
						defaults = credentials;
						return credentials;
					} catch (error) {
						if (error instanceof LoginPromptCancelled) return null;
						throw error;
					}
				},
				probe: async credentials => {
					this.ctx.chatContainer.addChild(new Spacer(1));
					this.ctx.chatContainer.addChild(
						new Text(theme.fg("dim", `Connecting to ${credentials.baseUrl}…`), 1, 0),
					);
					this.ctx.ui.requestRender();
					const probe = await probeLiteLLMConnection(credentials.baseUrl, credentials.apiKey);
					if (probe.reachable) {
						this.ctx.chatContainer.addChild(
							new Text(
								theme.fg("success", `${theme.status.success} OK — ${probe.models.length} models available`),
								1,
								0,
							),
						);
						this.ctx.ui.requestRender();
					}
					return probe;
				},
				selectModel: choices => this.#showLiteLLMLoginModelSelector(choices),
				commit: input =>
					commitLiteLLMLogin({
						...input,
						modelsPath,
						configPath,
						session: this.ctx.session,
					}),
				recover: request => this.#showLoginRecovery(request),
			});

			if (flowResult.status === "cancelled") {
				this.ctx.showStatus("LiteLLM login cancelled. Existing configuration unchanged.");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `LiteLLM configuration saved to ${modelsPath}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(
				new Text(
					theme.fg("success", `Default model: ${flowResult.choice.provider}/${flowResult.choice.modelId} (high)`),
					1,
					0,
				),
			);
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("dim", "Use /model to switch models without logging in again."), 1, 0),
			);
			this.ctx.ui.requestRender();
		} catch (error: unknown) {
			this.ctx.showError(`LiteLLM login failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #handleVllmLogin(): Promise<void> {
		this.ctx.showStatus("Configuring vLLM…");
		const modelsPath = path.join(getAgentDir(), "models.yml");

		try {
			let defaultBaseUrl = readVllmConfig(modelsPath)?.baseUrl ?? DEFAULT_VLLM_BASE_URL;
			const storedCredential = this.ctx.session.modelRegistry.authStorage.get("vllm");
			const hadStoredKey = storedCredential?.type === "api_key" && storedCredential.key.length > 0;
			const flowResult = await runVllmLoginFlow({
				collectCredentials: async () => {
					try {
						let baseUrl: string;
						while (true) {
							const value = await this.#promptLoginValue({
								message: `vLLM Base URL [${defaultBaseUrl}]`,
								placeholder: DEFAULT_VLLM_BASE_URL,
								allowEmpty: true,
							});
							try {
								baseUrl = normalizeVllmBaseUrl(value.trim() || defaultBaseUrl);
								break;
							} catch (error) {
								this.ctx.showError(error instanceof Error ? error.message : String(error));
							}
						}
						const apiKey = await this.#promptLoginValue({
							message: hadStoredKey
								? "Optional vLLM API key [stored securely; leave blank to remove authentication]"
								: "Optional vLLM API key [leave blank for keyless local service]",
							allowEmpty: true,
							secret: true,
						});
						defaultBaseUrl = baseUrl;
						return { baseUrl, apiKey };
					} catch (error) {
						if (error instanceof LoginPromptCancelled) return null;
						throw error;
					}
				},
				probe: async credentials => {
					this.ctx.chatContainer.addChild(new Spacer(1));
					this.ctx.chatContainer.addChild(
						new Text(theme.fg("dim", `Connecting to ${credentials.baseUrl}/models…`), 1, 0),
					);
					this.ctx.ui.requestRender();
					const probe = await probeVllmConnection(credentials.baseUrl, credentials.apiKey);
					this.ctx.chatContainer.addChild(
						new Text(
							theme.fg("success", `${theme.status.success} OK — ${probe.models.length} vLLM models available`),
							1,
							0,
						),
					);
					this.ctx.ui.requestRender();
					return probe;
				},
				selectModel: choices => this.#showVllmLoginModelSelector(choices),
				commit: input =>
					commitVllmLogin({
						modelsPath,
						credentials: input.credentials,
						choice: input.choice,
						session: this.ctx.session,
					}),
				recover: request => this.#showLoginRecovery(request, "vLLM"),
			});

			if (flowResult.status === "cancelled") {
				this.ctx.showStatus("vLLM login cancelled. Existing configuration unchanged.");
				return;
			}
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} vLLM configuration saved to ${modelsPath}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(
				new Text(
					theme.fg(
						"success",
						`Default model: vllm/${flowResult.choice.modelId} (${formatLoginThinkingState(this.ctx.session.thinkingLevel)})`,
					),
					1,
					0,
				),
			);
			if (this.ctx.session.modelRegistry.authStorage.get("vllm")) {
				this.ctx.chatContainer.addChild(
					new Text(theme.fg("dim", `API key saved only to ${getAgentDbPath()}`), 1, 0),
				);
			}
			this.ctx.ui.requestRender();
		} catch (error) {
			this.ctx.showError(`vLLM login failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #handleOAuthLogin(providerId: string): Promise<void> {
		if (providerId === "google-vertex") {
			await this.#handleVertexLogin();
			return;
		}
		if (providerId === "openai") {
			this.#showOpenAIApiKeyGuidance();
			return;
		}
		// LiteLLM has its own flow with config persistence
		if (providerId === "litellm") {
			return this.#handleLiteLLMLogin();
		}
		if (providerId === "vllm") {
			return this.#handleVllmLogin();
		}

		let openAICodexMethod: "browser" | "device" | undefined;
		if (providerId === "openai-codex") {
			openAICodexMethod = await this.#selectOpenAICodexLoginMethod();
			if (!openAICodexMethod) {
				this.ctx.showStatus("ChatGPT login cancelled.");
				return;
			}
		}
		this.ctx.showStatus(`Logging in to ${providerId}…`);
		const manualInput = this.ctx.oauthManualInput;
		const useManualInput =
			CALLBACK_SERVER_PROVIDERS.has(providerId as OAuthProvider) || providerId === "openai-codex";
		const shouldOpenBrowser = providerId !== "openai-codex" || openAICodexMethod === "browser";
		let endAuthorizationWait: (() => void) | undefined;
		const loginCallbacks = {
			method: openAICodexMethod,
			onAuth: (info: {
				url: string;
				openUrl?: string;
				instructions?: string;
				kind?: "browser" | "device";
				userCode?: string;
			}) => {
				this.ctx.chatContainer.addChild(new Spacer(1));
				if (info.kind === "device" && info.userCode) {
					presentDeviceCode(this.ctx.chatContainer, info.url, info.userCode);
				} else {
					presentAuthLink(this.ctx.chatContainer, info.url);
				}
				if (info.instructions) {
					this.ctx.chatContainer.addChild(new Spacer(1));
					this.ctx.chatContainer.addChild(new Text(theme.fg("warning", info.instructions), 1, 0));
				}
				if (useManualInput) {
					this.ctx.chatContainer.addChild(new Spacer(1));
					this.ctx.chatContainer.addChild(new Text(theme.fg("dim", MANUAL_LOGIN_TIP), 1, 0));
				}
				this.ctx.ui.requestRender();
				if (shouldOpenBrowser) {
					const launch = this.#launchHttpUrl(info.openUrl ?? info.url);
					void launch.then(result => {
						if (!result.ok) this.ctx.showWarning(`Could not open the sign-in page: ${result.error}`);
					});
				}
				endAuthorizationWait ??= this.#beginPromptSignal("input");
			},
			onPrompt: async (prompt: OAuthPrompt) => {
				this.ctx.chatContainer.addChild(new Spacer(1));
				this.ctx.chatContainer.addChild(new Text(theme.fg("warning", prompt.message), 1, 0));
				if (prompt.placeholder) {
					this.ctx.chatContainer.addChild(new Text(theme.fg("dim", prompt.placeholder), 1, 0));
				}
				this.ctx.ui.requestRender();
				const { promise, resolve, reject } = Promise.withResolvers<string>();
				const codeInput = createLoginPromptInput(prompt);
				const closeInput = () => {
					this.ctx.editorContainer.clear();
					this.ctx.editorContainer.addChild(this.ctx.editor);
					this.ctx.ui.setFocus(this.ctx.editor);
				};
				codeInput.onSubmit = () => {
					const code = codeInput.getValue();
					closeInput();
					if (prompt.copyText && /^(?:c|copy)$/i.test(code.trim())) {
						void copyToClipboard(prompt.copyText).catch(() => undefined);
						this.ctx.showStatus("One-time code copied when terminal clipboard support is available.");
						resolve("");
						return;
					}
					resolve(code);
				};
				codeInput.onEscape = () => {
					closeInput();
					reject(new LoginPromptCancelled("Login cancelled"));
				};
				this.ctx.editorContainer.clear();
				this.ctx.editorContainer.addChild(codeInput);
				this.ctx.ui.setFocus(codeInput);
				this.ctx.ui.requestRender();
				const endPrompt = this.#beginPromptSignal("input");
				return promise.finally(endPrompt);
			},
			onProgress: (message: string) => {
				this.ctx.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
				this.ctx.ui.requestRender();
			},
			onManualCodeInput: useManualInput ? () => manualInput.waitForInput(providerId) : undefined,
		};
		try {
			let loginModelChoice: Awaited<ReturnType<typeof applyOAuthLoginModel>>;
			if (providerId === "google-antigravity-enterprise") {
				const result = await runEnterpriseOAuthLoginFlow({
					capture: () => captureEnterpriseOAuthLoginState(this.ctx.session),
					authenticate: async action => {
						this.ctx.showStatus(
							action === "edit"
								? "Editing Google Antigravity Enterprise project and sign-in…"
								: "Authenticating Google Antigravity Enterprise…",
						);
						await this.ctx.session.modelRegistry.authStorage.login(providerId, loginCallbacks);
					},
					applyModel: async () => {
						await this.ctx.session.modelRegistry.refresh("online");
						return Boolean(await applyOAuthLoginModel(this.ctx.session, providerId));
					},
					restore: snapshot => restoreEnterpriseOAuthLoginState(this.ctx.session, snapshot),
					recover: request =>
						this.#showLoginRecovery(request, "Google Antigravity Enterprise", "Edit project / sign-in"),
				});
				if (result.status === "cancelled") {
					this.ctx.showStatus("Google Antigravity Enterprise login cancelled. Existing configuration unchanged.");
					return;
				}
				loginModelChoice = GOOGLE_ANTIGRAVITY_LOGIN_MODEL_CHOICE;
			} else {
				await this.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, loginCallbacks);
				// Force entitlement discovery after login so /model reflects the provider immediately.
				await this.ctx.session.modelRegistry.refresh("online");
				loginModelChoice = await applyOAuthLoginModel(this.ctx.session, providerId);
			}
			if (loginModelChoice) {
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
			}
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged in to ${providerId}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(new Text(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`), 1, 0));
			if (loginModelChoice) {
				this.ctx.chatContainer.addChild(
					new Text(
						theme.fg(
							"success",
							`Default model: ${loginModelChoice.provider}/${loginModelChoice.modelId}; ${formatLoginThinkingState(loginModelChoice.thinkingLevel)}`,
						),
						1,
						0,
					),
				);
			} else if (providerId === "anthropic") {
				this.ctx.chatContainer.addChild(
					new Text(
						theme.fg(
							"warning",
							"Claude login is valid, but fresh Haiku 4.5, Sonnet 5, and Opus 5 entitlements are required before changing the active profile. Use /model to select an available model.",
						),
						1,
						0,
					),
				);
			}
			this.ctx.ui.requestRender();
		} catch (error: unknown) {
			this.ctx.showError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (useManualInput) {
				manualInput.clear(`Manual OAuth input cleared for ${providerId}`);
			}
			endAuthorizationWait?.();
		}
	}

	#selectOpenAICodexLoginMethod(): Promise<"browser" | "device" | undefined> {
		const ordered = getOpenAICodexLoginMethods();
		const labels = ordered.map(method =>
			method === "browser" ? "Browser Login — local PKCE callback" : "Device Code — SSH/headless friendly",
		);
		return new Promise(resolve => {
			this.showSelector(done => {
				const selector = new HookSelectorComponent(
					"ChatGPT subscription sign-in method",
					labels,
					label => {
						done();
						resolve(label.startsWith("Browser") ? "browser" : "device");
					},
					() => {
						done();
						resolve(undefined);
					},
					{ helpText: "ChatGPT subscription OAuth is separate from usage-based OpenAI API-key access." },
				);
				return { component: selector, focus: selector };
			});
		});
	}

	/** Corporate Vertex uses isolated standalone OAuth, never consumer Google credentials or ambient ADC. */
	async #handleVertexLogin(): Promise<void> {
		const runtime = defaultVertexLoginRuntime;
		try {
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			let accessToken = await authStorage.getApiKey("google-vertex");
			if (!accessToken) {
				this.ctx.showStatus("Authenticating Corporate Vertex with the authorized Google enterprise flow…");
				let endAuthorizationWait: (() => void) | undefined;
				try {
					await authStorage.login("google-vertex", {
						onAuth: info => {
							presentAuthLink(this.ctx.chatContainer, info.url);
							this.ctx.chatContainer.addChild(new Text(theme.fg("dim", VERTEX_MANUAL_LOGIN_TIP), 1, 0));
							if (!isHeadlessTerminal(runtime.environment)) {
								const launch = this.#launchHttpUrl(info.url);
								void launch.then(result => {
									if (!result.ok) this.ctx.showWarning(`Could not open the sign-in page: ${result.error}`);
								});
							}
							this.ctx.ui.requestRender();
							endAuthorizationWait ??= this.#beginPromptSignal("input");
						},
						onPrompt: prompt =>
							this.#promptLoginValue({
								message: prompt.message,
								placeholder: prompt.placeholder,
								allowEmpty: prompt.allowEmpty,
							}),
						onProgress: message => this.ctx.showStatus(message),
						onManualCodeInput: () => this.ctx.oauthManualInput.waitForInput("google-vertex"),
					});
				} finally {
					endAuthorizationWait?.();
				}
				accessToken = await authStorage.getApiKey("google-vertex");
				if (!accessToken) throw new Error("Vertex OAuth authentication did not return an access token");
			}
			const detected = await detectVertexProject(runtime);
			const proposed = await this.#promptLoginValue({
				message: detected
					? `Vertex AI project: ${detected.id} (${detected.source}). Press Enter to confirm, or type another project.`
					: "Vertex AI project ID (required; Esc cancels):",
				placeholder: detected?.id,
				allowEmpty: true,
			});
			const project = proposed.trim() || detected?.id;
			if (!project) {
				this.ctx.showStatus("Vertex AI login cancelled. Existing configuration unchanged.");
				return;
			}

			try {
				this.ctx.showStatus("Validating Vertex AI OAuth credentials and Gemini 3.8 Flash access…");
				await validateVertexLogin(runtime, project, accessToken);
			} catch (error) {
				const action = await this.#showLoginRecovery(
					{ stage: "validation", error: vertexFailureGuidance(error, project), canEdit: true },
					"Google Cloud Vertex AI",
					"Sign in with gcloud",
				);
				if (action === "cancel") {
					this.ctx.showStatus("Vertex AI login cancelled. Existing configuration unchanged.");
					return;
				}
				if (action === "edit") throw new Error("Retry `/login google-vertex` to authenticate again.");
				await validateVertexLogin(runtime, project, accessToken);
			}

			await this.ctx.session.modelRegistry.refreshProvider("google-vertex", "online");
			const applied = await applyModelAfterLogin(this.ctx.session, GOOGLE_VERTEX_LOGIN_MODEL_CHOICE);
			if (!applied) throw new Error("Gemini 3.8 Flash is unavailable in the local Vertex model registry");
			this.ctx.session.settings.set("providers.vertexProject", project);
			this.ctx.session.settings.set("providers.vertexLocation", "global");
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			this.ctx.showStatus("Vertex AI configured: google-vertex/gemini-3.8-flash:high (global)");
		} catch (error) {
			if (error instanceof LoginPromptCancelled) {
				this.ctx.showStatus("Vertex AI login cancelled. Existing configuration unchanged.");
				return;
			}
			this.ctx.showError(`Vertex AI login failed: ${vertexFailureGuidance(error)}`);
		}
	}

	#showOpenAIApiKeyGuidance(): void {
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(
			new Text(theme.fg("warning", "OpenAI Responses API uses usage-based Platform API access."), 1, 0),
		);
		this.ctx.chatContainer.addChild(
			new Text(theme.fg("dim", "Set OPENAI_API_KEY, then select an OpenAI model with /model."), 1, 0),
		);
		this.ctx.chatContainer.addChild(
			new Text(theme.fg("dim", "For ChatGPT subscription access, choose ChatGPT Plus/Pro in /login."), 1, 0),
		);
		this.ctx.ui.requestRender();
	}

	async #handleOAuthLogout(providerId: string): Promise<void> {
		try {
			await this.ctx.session.modelRegistry.authStorage.logout(providerId);
			await this.ctx.session.modelRegistry.refresh();
			this.ctx.chatContainer.addChild(new Spacer(1));
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("success", `${theme.status.success} Successfully logged out of ${providerId}`), 1, 0),
			);
			this.ctx.chatContainer.addChild(
				new Text(theme.fg("dim", `Credentials removed from ${getAgentDbPath()}`), 1, 0),
			);
			this.ctx.ui.requestRender();
		} catch (error: unknown) {
			this.ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async showFirstRunLogin(): Promise<void> {
		await this.showOAuthSelector("login");
	}

	async showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		if (providerId) {
			if (mode === "login") {
				await this.#handleOAuthLogin(providerId);
			} else {
				await this.#handleOAuthLogout(providerId);
			}
			return;
		}

		if (mode === "logout") {
			await this.#refreshOAuthProviderAuthState();
			const oauthProviders = getOAuthProviders().filter(provider => !provider.loginOnly);
			const loggedInProviders = oauthProviders.filter(provider =>
				this.ctx.session.modelRegistry.authStorage.hasAuth(provider.id),
			);
			if (loggedInProviders.length === 0) {
				this.ctx.showStatus("No OAuth providers logged in. Use /login first.");
				return;
			}
		}

		this.showSelector(
			done => {
				let selector: OAuthSelectorComponent;
				selector = new OAuthSelectorComponent(
					mode,
					this.ctx.session.modelRegistry.authStorage,
					async (selectedProviderId: string) => {
						selector.stopValidation();
						done();
						if (mode === "login") {
							await this.#handleOAuthLogin(selectedProviderId);
						} else {
							await this.#handleOAuthLogout(selectedProviderId);
						}
					},
					() => {
						selector.stopValidation();
						done();
						this.ctx.ui.requestRender();
					},
					{
						validateAuth: async (selectedProviderId: string) => {
							const apiKey = await this.ctx.session.modelRegistry.getApiKeyForProvider(
								selectedProviderId,
								this.ctx.session.sessionId,
							);
							return !!apiKey;
						},
						requestRender: () => {
							this.ctx.ui.requestRender();
						},
					},
				);
				return { component: selector, focus: selector };
			},
			mode === "login" ? "select" : undefined,
		);
	}

	showDebugSelector(): void {
		this.showSelector(done => {
			const selector = new DebugSelectorComponent(this.ctx, done);
			return { component: selector, focus: selector };
		});
	}

	showSessionObserver(registry: SessionObserverRegistry): void {
		const observeKeys = this.ctx.keybindings.getKeys("app.session.observe");

		this.showSelector(done => {
			let cleanup: (() => void) | undefined;

			const selector = new SessionObserverOverlayComponent(
				registry,
				() => {
					cleanup?.();
					done();
				},
				observeKeys,
			);

			cleanup = registry.onChange(() => {
				selector.refreshFromRegistry();
				this.ctx.ui.requestRender();
			});

			return { component: selector, focus: selector };
		});
	}
}
