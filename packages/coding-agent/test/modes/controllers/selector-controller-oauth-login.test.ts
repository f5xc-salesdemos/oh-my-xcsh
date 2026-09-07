import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@f5-sales-demo/pi-agent-core";
import { AuthCredentialStore, AuthStorage } from "@f5-sales-demo/pi-ai";
import { SelectorController } from "../../../src/modes/controllers/selector-controller";
import { OAuthManualInputManager } from "../../../src/modes/oauth-manual-input";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

const LONG_AUTH_URL =
	"https://login.example.test/authorize?client_id=synthetic-client&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&scope=openid%20profile&state=synthetic-state&code_challenge=synthetic-challenge";

function renderVisible(components: Array<{ render(width: number): string[] }>, width = 40): string {
	return Bun.stripANSI(components.flatMap(component => component.render(width)).join("\n"))
		.replace(/\s+/g, " ")
		.trim();
}

beforeAll(() => {
	initTheme();
});

describe("SelectorController native login lifecycle", () => {
	it("emits select prompt lifecycle events when the OAuth provider selector opens and is cancelled", async () => {
		const emit = vi.fn(async (_event: unknown) => undefined);
		const editorContainer = {
			children: [] as Array<{ handleInput?: (key: string) => void }>,
			clear() {
				this.children = [];
			},
			addChild(child: { handleInput?: (key: string) => void }) {
				this.children.push(child);
			},
		};
		const ctx = {
			editorContainer,
			editor: {},
			session: {
				extensionRunner: { emit },
				modelRegistry: {
					authStorage: { hasAuth: () => false },
					getApiKeyForProvider: vi.fn(async () => undefined),
				},
			},
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		} as unknown as InteractiveModeContext;

		await new SelectorController(ctx).showOAuthSelector("login");

		expect(emit).toHaveBeenCalledWith({ type: "user_prompt_start", kind: "select" });
		editorContainer.children[0]?.handleInput?.("\x1b");
		expect(emit).toHaveBeenLastCalledWith({ type: "user_prompt_end", kind: "select" });
	});
});

describe("SelectorController Google Antigravity login", () => {
	it("persists and reports Gemini 3.6 Flash High after OAuth succeeds", async () => {
		const model = {
			id: "gemini-3.6-flash-high",
			provider: "google-antigravity",
		};
		const addedComponents: Array<{ render(width: number): string[] }> = [];
		const login = vi.fn(async () => undefined);
		const refresh = vi.fn(async () => undefined);
		const setModel = vi.fn(async () => undefined);
		const setThinkingLevel = vi.fn();
		const invalidate = vi.fn();
		const updateEditorBorderColor = vi.fn();
		const showError = vi.fn();
		const ctx = {
			session: {
				modelRegistry: {
					authStorage: { login },
					refresh,
					getAll: () => [model],
				},
				setModel,
				setThinkingLevel,
			},
			oauthManualInput: new OAuthManualInputManager(),
			statusLine: { invalidate },
			updateEditorBorderColor,
			chatContainer: {
				addChild: (component: { render(width: number): string[] }) => addedComponents.push(component),
			},
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError,
			openInBrowser: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new SelectorController(ctx).showOAuthSelector("login", "google-antigravity");

		expect(login).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith("online");
		expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(setModel.mock.invocationCallOrder[0]);
		expect(setModel).toHaveBeenCalledWith(model, "default", {
			selector: "google-antigravity/gemini-3.6-flash-high",
			thinkingLevel: ThinkingLevel.High,
		});
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();

		const rendered = addedComponents.flatMap(component => component.render(120)).join("\n");
		expect(rendered).toContain("Successfully logged in to google-antigravity");
		expect(rendered).toContain("Default model: google-antigravity/gemini-3.6-flash-high");
	});

	it("presents the shared short link, instructions, browser policy, and manual pairing", async () => {
		const model = { id: "gemini-3.6-flash-high", provider: "google-antigravity" };
		const addedComponents: Array<{ render(width: number): string[] }> = [];
		const manualInput = new OAuthManualInputManager();
		const openInBrowser = vi.fn();
		const login = vi.fn(async (_provider, callbacks) => {
			callbacks.onAuth({ url: LONG_AUTH_URL, instructions: "Finish the provider instructions." });
			expect(callbacks.onManualCodeInput).toBeDefined();
			const redirect = callbacks.onManualCodeInput();
			expect(manualInput.submit("http://localhost/callback?code=synthetic&state=valid")).toBe(true);
			await expect(redirect).resolves.toContain("code=synthetic");
		});
		const ctx = {
			session: {
				modelRegistry: { authStorage: { login }, refresh: vi.fn(async () => undefined), getAll: () => [model] },
				setModel: vi.fn(async () => undefined),
				setThinkingLevel: vi.fn(),
			},
			oauthManualInput: manualInput,
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			chatContainer: {
				addChild: (component: { render(width: number): string[] }) => addedComponents.push(component),
			},
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			openInBrowser,
		} as unknown as InteractiveModeContext;

		await new SelectorController(ctx).showOAuthSelector("login", "google-antigravity");

		const visible = renderVisible(addedComponents);
		expect(visible).toContain("Open sign-in page");
		expect(visible).toContain(process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open");
		expect(visible).toContain("Finish the provider instructions.");
		expect(visible).toContain("Tip: You can complete pairing with /login <redirect URL>.");
		expect(visible).not.toContain(LONG_AUTH_URL);
		expect(openInBrowser).toHaveBeenCalledTimes(1);
		expect(openInBrowser).toHaveBeenCalledWith(LONG_AUTH_URL);
	});
});

describe("SelectorController Corporate Vertex login", () => {
	it("reports the licensed build/configuration cause when OAuth fails before presenting an action", async () => {
		const previousClientId = Bun.env.XCSH_VERTEX_OAUTH_CLIENT_ID;
		const previousClientSecret = Bun.env.XCSH_VERTEX_OAUTH_CLIENT_SECRET;
		delete Bun.env.XCSH_VERTEX_OAUTH_CLIENT_ID;
		delete Bun.env.XCSH_VERTEX_OAUTH_CLIENT_SECRET;
		const authStorage = new AuthStorage(new AuthCredentialStore(new Database(":memory:")));
		try {
			const showError = vi.fn();
			const setSetting = vi.fn();
			const reachedAuthAction = vi.fn();
			const login = vi.fn(async (_provider, callbacks) => {
				await authStorage.login("google-vertex", {
					...callbacks,
					onAuth: info => {
						reachedAuthAction();
						callbacks.onAuth(info);
					},
				});
			});
			const ctx = {
				session: {
					modelRegistry: { authStorage: { getApiKey: vi.fn(async () => undefined), login } },
					settings: { set: setSetting },
				},
				oauthManualInput: new OAuthManualInputManager(),
				chatContainer: { addChild: vi.fn() },
				ui: { requestRender: vi.fn() },
				showStatus: vi.fn(),
				showError,
				openInBrowser: vi.fn(),
			} as unknown as InteractiveModeContext;

			await new SelectorController(ctx).showOAuthSelector("login", "google-vertex");

			expect(login).toHaveBeenCalledWith("google-vertex", expect.any(Object));
			expect(authStorage.list()).toEqual([]);
			expect(reachedAuthAction).not.toHaveBeenCalled();
			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("Corporate Vertex OAuth credentials are unavailable in this build"),
			);
			expect(showError).toHaveBeenCalledWith(expect.stringContaining("Install an official xcsh binary"));
			expect(setSetting).not.toHaveBeenCalled();
		} finally {
			authStorage.close();
			if (previousClientId === undefined) delete Bun.env.XCSH_VERTEX_OAUTH_CLIENT_ID;
			else Bun.env.XCSH_VERTEX_OAUTH_CLIENT_ID = previousClientId;
			if (previousClientSecret === undefined) delete Bun.env.XCSH_VERTEX_OAUTH_CLIENT_SECRET;
			else Bun.env.XCSH_VERTEX_OAUTH_CLIENT_SECRET = previousClientSecret;
		}
	});

	it("preserves existing Vertex settings when project confirmation is cancelled", async () => {
		const previousProject = Bun.env.GOOGLE_CLOUD_PROJECT;
		Bun.env.GOOGLE_CLOUD_PROJECT = "detected-project";
		try {
			const emit = vi.fn(async (_event: unknown) => undefined);
			const setSetting = vi.fn();
			const showStatus = vi.fn();
			const editorContainer = {
				children: [] as Array<{ handleInput?: (key: string) => void }>,
				clear() {
					this.children = [];
				},
				addChild(child: { handleInput?: (key: string) => void }) {
					this.children.push(child);
				},
			};
			const ctx = {
				editorContainer,
				editor: {},
				session: {
					extensionRunner: { emit },
					modelRegistry: {
						authStorage: {
							getApiKey: vi.fn(async () => "existing-vertex-token"),
							login: vi.fn(),
						},
					},
					settings: { set: setSetting },
				},
				oauthManualInput: new OAuthManualInputManager(),
				chatContainer: { addChild: vi.fn() },
				ui: { requestRender: vi.fn(), setFocus: vi.fn() },
				showStatus,
				showError: vi.fn(),
				openInBrowser: vi.fn(),
			} as unknown as InteractiveModeContext;

			const loginPromise = new SelectorController(ctx).showOAuthSelector("login", "google-vertex");
			await Bun.sleep(0);
			expect(emit).toHaveBeenLastCalledWith({ type: "user_prompt_start", kind: "input" });
			editorContainer.children[0]?.handleInput?.("\x1b");
			await loginPromise;

			expect(emit.mock.calls).toEqual([
				[{ type: "user_prompt_start", kind: "input" }],
				[{ type: "user_prompt_end", kind: "input" }],
			]);
			expect(setSetting).not.toHaveBeenCalled();
			expect(showStatus).toHaveBeenLastCalledWith("Vertex AI login cancelled. Existing configuration unchanged.");
		} finally {
			if (previousProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
			else Bun.env.GOOGLE_CLOUD_PROJECT = previousProject;
		}
	});

	it("emits input lifecycle events while OAuth authorization awaits a manual code", async () => {
		const previousHerdr = process.env.HERDR_ENV;
		process.env.HERDR_ENV = "1";
		try {
			const emit = vi.fn(async (_event: unknown) => undefined);
			const manualInput = new OAuthManualInputManager();
			const authorizationShown = Promise.withResolvers<void>();
			const login = vi.fn(async (_provider, callbacks) => {
				callbacks.onAuth({ url: LONG_AUTH_URL });
				const code = callbacks.onManualCodeInput();
				authorizationShown.resolve();
				await code;
				throw new Error("stop after authorization wait");
			});
			const ctx = {
				session: {
					extensionRunner: { emit },
					modelRegistry: { authStorage: { getApiKey: vi.fn(async () => undefined), login } },
				},
				oauthManualInput: manualInput,
				chatContainer: { addChild: vi.fn() },
				ui: { requestRender: vi.fn() },
				showStatus: vi.fn(),
				showError: vi.fn(),
				openInBrowser: vi.fn(),
			} as unknown as InteractiveModeContext;

			const loginPromise = new SelectorController(ctx).showOAuthSelector("login", "google-vertex");
			await authorizationShown.promise;

			expect(emit.mock.calls).toEqual([[{ type: "user_prompt_start", kind: "input" }]]);
			expect(manualInput.submit("synthetic-code")).toBe(true);
			await loginPromise;
			expect(emit).toHaveBeenLastCalledWith({ type: "user_prompt_end", kind: "input" });
		} finally {
			if (previousHerdr === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previousHerdr;
		}
	});

	it("keeps SSH login manual with a usable recovery action", async () => {
		const environment = {
			SSH_CONNECTION: "synthetic-client synthetic-server",
			HERDR_ENV: "",
			DISPLAY: ":0",
			CLOUD_SHELL: "",
		};
		const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
		Object.assign(process.env, environment);
		try {
			const addedComponents: Array<{ render(width: number): string[] }> = [];
			const openInBrowser = vi.fn();
			let submitted = false;
			let receivedCode: string | undefined;
			const login = vi.fn(async (_provider, callbacks) => {
				callbacks.onAuth({ url: LONG_AUTH_URL });
				const pending = callbacks.onManualCodeInput();
				submitted = ctx.oauthManualInput.submit("synthetic-code");
				receivedCode = await pending;
				throw new Error("stop after presentation");
			});
			const ctx = {
				session: { modelRegistry: { authStorage: { getApiKey: vi.fn(async () => undefined), login } } },
				oauthManualInput: new OAuthManualInputManager(),
				chatContainer: {
					addChild: (component: { render(width: number): string[] }) => addedComponents.push(component),
				},
				ui: { requestRender: vi.fn() },
				showStatus: vi.fn(),
				showError: vi.fn(),
				openInBrowser,
			} as unknown as InteractiveModeContext;

			await new SelectorController(ctx).showOAuthSelector("login", "google-vertex");

			const visible = renderVisible(addedComponents);
			expect(visible).toContain("Open sign-in page");
			expect(visible).toContain("Tip: After browser sign-in, complete pairing with /login <authorization code>.");
			expect(submitted).toBe(true);
			expect(receivedCode).toBe("synthetic-code");
			expect(visible).not.toContain("synthetic-code");
			expect(addedComponents.flatMap(component => component.render(500)).join("\n")).toContain(LONG_AUTH_URL);
			expect(visible).not.toContain(LONG_AUTH_URL);
			expect(openInBrowser).not.toHaveBeenCalled();
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("launches Vertex sign-in for local macOS under Herdr and retains manual recovery", async () => {
		if (process.platform !== "darwin") return;
		const previous = { HERDR_ENV: process.env.HERDR_ENV, SSH_CONNECTION: process.env.SSH_CONNECTION };
		process.env.HERDR_ENV = "1";
		delete process.env.SSH_CONNECTION;
		try {
			const addedComponents: Array<{ render(width: number): string[] }> = [];
			const manualInput = new OAuthManualInputManager();
			const openHttpUrl = vi.fn(async () => ({ ok: true as const }));
			const login = vi.fn(async (_provider, callbacks) => {
				callbacks.onAuth({ url: LONG_AUTH_URL });
				const pending = callbacks.onManualCodeInput();
				manualInput.submit("synthetic-code");
				await pending;
				throw new Error("stop after presentation");
			});
			const ctx = {
				session: { modelRegistry: { authStorage: { getApiKey: vi.fn(async () => undefined), login } } },
				oauthManualInput: manualInput,
				chatContainer: {
					addChild: (component: { render(width: number): string[] }) => addedComponents.push(component),
				},
				ui: { requestRender: vi.fn() },
				showStatus: vi.fn(),
				showError: vi.fn(),
				showWarning: vi.fn(),
				openHttpUrl,
			} as unknown as InteractiveModeContext;

			await new SelectorController(ctx).showOAuthSelector("login", "google-vertex");
			expect(openHttpUrl).toHaveBeenCalledWith(LONG_AUTH_URL);
			expect(renderVisible(addedComponents)).toContain("/login <authorization code>");
		} finally {
			if (previous.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previous.HERDR_ENV;
			if (previous.SSH_CONNECTION === undefined) delete process.env.SSH_CONNECTION;
			else process.env.SSH_CONNECTION = previous.SSH_CONNECTION;
		}
	});
});

describe("SelectorController ChatGPT device login", () => {
	it("does not try to open a browser on the remote Ubuntu host", async () => {
		const previousSshConnection = process.env.SSH_CONNECTION;
		process.env.SSH_CONNECTION = "client server";
		try {
			const openInBrowser = vi.fn();
			const refresh = vi.fn(async () => undefined);
			const manualInput = new OAuthManualInputManager();
			const editorContainer = {
				children: [] as Array<{ handleInput?: (key: string) => void }>,
				clear() {
					this.children = [];
				},
				addChild(child: { handleInput?: (key: string) => void }) {
					this.children.push(child);
				},
			};
			const login = vi.fn(async (_provider, callbacks) => {
				expect(callbacks.onManualCodeInput).toBeDefined();
				callbacks.onAuth({
					url: "https://auth.openai.com/oauth/authorize?state=redacted",
					instructions: "Complete browser login and paste the redirect URL",
				});
				const redirect = callbacks.onManualCodeInput();
				expect(manualInput.submit("http://localhost:1455/auth/callback?code=manual&state=valid")).toBe(true);
				await expect(redirect).resolves.toContain("code=manual");
			});
			const ctx = {
				editorContainer,
				editor: {},
				session: {
					modelRegistry: { authStorage: { login }, refresh, getAll: () => [] },
				},
				oauthManualInput: manualInput,
				statusLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				chatContainer: { addChild: vi.fn() },
				ui: { requestRender: vi.fn(), setFocus: vi.fn() },
				showStatus: vi.fn(),
				showError: vi.fn(),
				openInBrowser,
			} as unknown as InteractiveModeContext;

			const loginPromise = new SelectorController(ctx).showOAuthSelector("login", "openai-codex");
			await Bun.sleep(0);
			editorContainer.children[0]?.handleInput?.("\n");
			await loginPromise;

			expect(login).toHaveBeenCalledTimes(1);
			expect(login.mock.calls[0]?.[1]?.method).toBe("device");
			expect(refresh).toHaveBeenCalledWith("online");
			expect(openInBrowser).not.toHaveBeenCalled();
		} finally {
			if (previousSshConnection === undefined) delete process.env.SSH_CONNECTION;
			else process.env.SSH_CONNECTION = previousSshConnection;
		}
	});
});
