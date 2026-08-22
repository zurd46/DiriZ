/**
 * Provider- & Modell-Typen (`01-plan.md` §5).
 *
 * Die Adapter-Interface ist der einzige Kontrakt zwischen Core und den
 * LLM-Backends: Wer ihn einhält, ist austauschbar — Ollama, LM Studio,
 * OpenAI-kompatible Server, OpenRouter, OpenAI.
 */

export type ProviderType = "ollama" | "lmstudio" | "openai-compat" | "openrouter" | "openai"

export type ProviderStatus = "online" | "offline" | "degraded"

export type Capability = "code" | "reasoning" | "longform" | "vision" | "tools" | "json"

export type ModelSource = "discovered" | "manual"

/** `local-only` (Default) garantiert, dass kein Byte einen Cloud-Endpunkt erreicht. */
export type PrivacyMode = "local-only" | "allow-cloud"

export type RoutingMode = "auto" | "pinned" | "round-robin" | "cost-aware"

export interface HealthStatus {
	ok: boolean
	latencyMs: number
	detail?: string
}

/** Ein discovered Modell, wie es ein Provider meldet. */
export interface DiscoveredModel {
	modelId: string
	displayName: string
	contextWindow?: number
	capabilities?: Capability[]
	languages?: string[]
	quantization?: string
	/** Nur Cloud-Provider (USD pro Million Token). */
	pricePerMTok?: { in: number; out: number }
}

/**
 * Eine Instanz = ein konkret nutzbares Modell auf einem Provider.
 * `contextWindow` ist überschreibbar in der UI, wenn der Provider
 * unzuverlässige Angaben macht (Plan-Risiko §16).
 */
export interface InstanceModel {
	id: string
	providerId: string
	modelId: string
	displayName: string
	contextWindow: number
	capabilities: Capability[]
	languages: string[]
	quantization?: string
	pricePerMTok?: { in: number; out: number }
	source: ModelSource
	status: ProviderStatus
	/** Modell-spezifische Overrides — schlagen die Provider-Defaults. */
	modelSettings?: ModelSettings | null
	lastSeenAt: string
	lockedUntil?: string | null
}

/** Ein angebundener LLM-Server (Ollama, LM Studio, OpenRouter, …). */
export interface Provider {
	id: string
	type: ProviderType
	label: string
	baseUrl: string
	enabled: boolean
	status: ProviderStatus
	latencyP50?: number
	latencyP95?: number
	lastCheckedAt?: string
	config: Record<string, unknown>
	/** Default-Settings für alle Modelle auf diesem Rechner (volle Kontrolle). */
	modelSettings?: ModelSettings | null
	/** Ob ein API-Key hinterlegt ist — der Key selbst ist nie in der API sichtbar. */
	hasApiKey: boolean
}

/**
 * Model-Einstellungen — voll steuerbar pro Rechner (Provider), pro Modell
 * und pro Task. Auflösung (späterer Eintrag gewinnt):
 * Provider-Default ← Modell-Override ← Task-Override.
 */
export interface ModelSettings {
	temperature?: number
	topP?: number
	topK?: number
	minP?: number
	maxTokens?: number
	presencePenalty?: number
	frequencyPenalty?: number
	repeatPenalty?: number
	seed?: number
	stop?: string[]
	/** System-Prompt — gilt für alle Requests auf dieser Ebene. */
	systemPrompt?: string
}

export interface ChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

export interface ChatRequest {
	messages: ChatMessage[]
	model?: string
	/** Vollständige Model-Settings — gewinnen über temperature/maxTokens. */
	settings?: ModelSettings
	temperature?: number
	maxTokens?: number
	signal?: AbortSignal
}

/** Stream-Chunks eines Adapter-Calls. */
export type ChatChunk =
	| { type: "delta"; text: string }
	| { type: "usage"; tokensIn: number; tokensOut: number }
	| { type: "done" }

/** Provider-eigene Load-Info (z. B. Ollama `/api/ps`). */
export interface LoadInfo {
	loadedModels: { modelId: string; memoryBytes: number }[]
	totalMemoryBytes?: number
	usedMemoryBytes?: number
}

/**
 * Der Adapter-Kontrakt (§5.1). `chat` ist ein AsyncGenerator: Der Core pumpt
 * Deltas in den Event-Bus, und der Provider bleibt dabei austauschbar.
 */
export interface LLMProvider {
	readonly id: string
	readonly type: ProviderType
	readonly label: string
	healthCheck(): Promise<HealthStatus>
	listModels(): Promise<DiscoveredModel[]>
	chat(req: ChatRequest): AsyncGenerator<ChatChunk>
	/** Wo vom Provider unterstützt; sonst No-Op. */
	cancel(executionId: string): Promise<void>
	loadInfo?(): Promise<LoadInfo>
}
