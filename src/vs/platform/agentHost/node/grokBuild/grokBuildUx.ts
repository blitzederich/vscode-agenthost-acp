/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createSchema, platformSessionSchema, schemaProperty, type ISchemaProperty, type SessionMode } from '../../common/agentHostSchema.js';
import { AGENT_BUILTIN_CUSTOMIZATION_SCHEME } from '../../common/agentHostCustomizationUri.js';
import { ReasoningEffortConfigKey, getReasoningEffortDescription, getReasoningEffortLabel } from '../../common/reasoningEffort.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import { CustomizationLoadStatus, CustomizationType, customizationId, type DirectoryCustomization, type ModelSelection } from '../../common/state/sessionState.js';
import type { ConfigSchema } from '../../common/state/protocol/common/state.js';
import type { AcpConfigOption } from './protocol/acpTypes.js';

/** ACP config id for the reasoning-effort select. Live on grok 1.0.70. */
export const GROK_REASONING_CONFIG_ID = 'reasoning_effort';

/** Model-picker key shared with Codex (`thinkingLevel`). */
export const GROK_THINKING_LEVEL_KEY = ReasoningEffortConfigKey;

/**
 * Per-chat approval preset. Not Claude's `permissionMode` and not the
 * platform `autoApprove` enum: those include values this provider must never
 * send to the CLI (`bypassPermissions`, `dontAsk`, `auto`).
 */
export const GROK_PERMISSION_PRESET_KEY = 'grokPermissionPreset';

export const GROK_PERMISSION_PRESET_ASK = 'ask';
export const GROK_PERMISSION_PRESET_ALLOW_EDITS = 'allowEdits';

/** Live edit option id. Kind is `allow_always`; shell uses the same kind for a different option id. */
export const GROK_ALLOW_EDITS_OPTION_ID = 'allow-edits-session';

/**
 * Mode ids passed to `session/set_mode`. `session/new` does not advertise
 * `modes` and a live `session/set_mode` returned `{}`, so both ids are to verify live.
 * Launch argv stays `--permission-mode default`.
 */
export const GROK_PLAN_MODE_ID = 'plan';
export const GROK_DEFAULT_MODE_ID = 'default';

/** Host todo tool. The chat widget reads `toolSpecificData.kind === 'todoList'` for this id. */
export const GROK_TODO_TOOL_NAME = 'manage_todo_list';

/** Host subagent tool name. `toolKind: 'subagent'` is what the renderer groups on. */
export const GROK_SUBAGENT_TOOL_NAME = 'task';

export interface IGrokAvailableCommand {
	readonly name: string;
	readonly description?: string;
	readonly inputHint?: string;
}

export interface IGrokTodoItem {
	readonly id: string;
	readonly title: string;
	readonly status: 'not-started' | 'in-progress' | 'completed';
}

const SHELL_KINDS = new Set(['execute', 'shell']);
const SHELL_NAMES = new Set(['bash', 'shell', 'run_terminal_command']);
const EDIT_KINDS = new Set(['edit']);
const EDIT_NAMES = new Set(['search_replace', 'write', 'edit']);
const SUBAGENT_KINDS = new Set(['subagent', 'task']);
const SUBAGENT_NAMES = new Set(['spawn_subagent']);

export function readConfigOptions(value: unknown): readonly AcpConfigOption[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is AcpConfigOption => {
		return !!entry && typeof entry === 'object' && typeof (entry as AcpConfigOption).id === 'string';
	});
}

export function readReasoningEffortOption(configOptions: readonly unknown[] | null | undefined): AcpConfigOption | undefined {
	return readConfigOptions(configOptions).find(option => option.id === GROK_REASONING_CONFIG_ID || option.category === 'thought_level');
}

export function reasoningEffortConfigSchema(option: AcpConfigOption | undefined): ConfigSchema | undefined {
	const choices = option?.options?.filter(choice => typeof choice?.value === 'string' && choice.value.length > 0) ?? [];
	if (choices.length === 0) {
		return undefined;
	}
	const values = choices.map(choice => choice.value);
	const current = typeof option?.currentValue === 'string' && values.includes(option.currentValue) ? option.currentValue : undefined;
	return {
		type: 'object',
		properties: {
			[GROK_THINKING_LEVEL_KEY]: {
				type: 'string',
				title: localize('grokBuild.model.reasoningEffort', "Reasoning Effort"),
				description: localize('grokBuild.model.reasoningEffortDescription', "How much reasoning Grok Build uses for this chat."),
				...(current ? { default: current } : {}),
				enum: values,
				enumLabels: choices.map(choice => getReasoningEffortLabel(choice.value)),
				enumDescriptions: choices.map(choice => {
					if (typeof choice.description === 'string' && choice.description.length > 0) {
						return choice.description;
					}
					return getReasoningEffortDescription(choice.value) ?? '';
				}),
			},
		},
	};
}

export function thinkingLevelOf(model: ModelSelection | undefined): string | undefined {
	const value = model?.config?.[GROK_THINKING_LEVEL_KEY];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function modelWithThinkingLevel(model: ModelSelection | undefined, effort: string | undefined): ModelSelection | undefined {
	if (!model) {
		return undefined;
	}
	if (!effort) {
		return model;
	}
	return {
		...model,
		config: { ...model.config, [GROK_THINKING_LEVEL_KEY]: effort },
	};
}

/**
 * Reads `available_commands_update`. A non-array payload (the captured logs
 * replaced the array with a redaction string) returns `undefined` so the
 * previous command list is kept. An array, including an empty one, is authoritative.
 */
export function readAvailableCommands(update: unknown): readonly IGrokAvailableCommand[] | undefined {
	if (!update || typeof update !== 'object') {
		return undefined;
	}
	const raw = (update as { availableCommands?: unknown }).availableCommands;
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const commands: IGrokAvailableCommand[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object' || typeof (entry as { name?: unknown }).name !== 'string') {
			continue;
		}
		const name = (entry as { name: string }).name;
		if (name.length === 0) {
			continue;
		}
		const description = typeof (entry as { description?: unknown }).description === 'string'
			? (entry as { description: string }).description
			: undefined;
		const input = (entry as { input?: unknown }).input;
		const inputHint = input && typeof input === 'object' && typeof (input as { hint?: unknown }).hint === 'string'
			? (input as { hint: string }).hint
			: undefined;
		commands.push({ name, description, inputHint });
	}
	return commands;
}

export function sameCommands(left: readonly IGrokAvailableCommand[] | undefined, right: readonly IGrokAvailableCommand[]): boolean {
	if (!left || left.length !== right.length) {
		return false;
	}
	return left.every((command, index) => {
		const other = right[index];
		return command.name === other.name && command.description === other.description && command.inputHint === other.inputHint;
	});
}

/**
 * Read-only slash commands. The host invokes a skill by sending its name as
 * prompt text; this provider forwards that text unchanged.
 */
export function buildGrokCommandCustomizations(commands: readonly IGrokAvailableCommand[]): DirectoryCustomization | undefined {
	if (commands.length === 0) {
		return undefined;
	}
	const children = commands.map(command => {
		const uri = URI.from({
			scheme: AGENT_BUILTIN_CUSTOMIZATION_SCHEME,
			path: `/grok-build/skill/${encodeURIComponent(command.name)}`,
		}).toString();
		const hint = command.inputHint ? ` (${command.inputHint})` : '';
		return {
			type: CustomizationType.Skill as const,
			id: customizationId(uri),
			uri,
			name: command.name,
			description: `${command.description ?? ''}${hint}`.trim() || undefined,
			disableModelInvocation: true,
		};
	});
	const containerUri = URI.from({ scheme: AGENT_BUILTIN_CUSTOMIZATION_SCHEME, path: '/grok-build/skills' }).toString();
	return {
		type: CustomizationType.Directory,
		id: customizationId(containerUri),
		uri: containerUri,
		name: localize('grokBuild.commands.container', "Grok Build"),
		enabled: true,
		contents: CustomizationType.Skill,
		writable: false,
		load: { kind: CustomizationLoadStatus.Loaded },
		children,
	};
}

function createGrokModeSchema(): ISchemaProperty<SessionMode> {
	const base = platformSessionSchema.definition[SessionConfigKey.Mode].protocol;
	const kept = (base.enum ?? []).flatMap((value, index) => value === 'autopilot' ? [] : [index]);
	return schemaProperty<SessionMode>({
		...base,
		enum: kept.map(index => base.enum![index]),
		enumLabels: base.enumLabels && kept.map(index => base.enumLabels![index]),
		enumDescriptions: base.enumDescriptions && kept.map(index => base.enumDescriptions![index]),
	});
}

export const grokBuildSessionSchema = createSchema({
	[SessionConfigKey.Mode]: createGrokModeSchema(),
	[GROK_PERMISSION_PRESET_KEY]: schemaProperty<typeof GROK_PERMISSION_PRESET_ASK | typeof GROK_PERMISSION_PRESET_ALLOW_EDITS>({
		type: 'string',
		title: localize('grokBuild.sessionConfig.permissionPreset', "Approvals"),
		description: localize('grokBuild.sessionConfig.permissionPresetDescription', "When Grok Build asks before editing files. Shell commands always ask."),
		enum: [GROK_PERMISSION_PRESET_ASK, GROK_PERMISSION_PRESET_ALLOW_EDITS],
		enumLabels: [
			localize('grokBuild.sessionConfig.permissionPreset.ask', "Ask Every Time"),
			localize('grokBuild.sessionConfig.permissionPreset.allowEdits', "Allow Edits This Session"),
		],
		enumDescriptions: [
			localize('grokBuild.sessionConfig.permissionPreset.askDescription', "Ask before every edit and every shell command."),
			localize('grokBuild.sessionConfig.permissionPreset.allowEditsDescription', "Allow file edits for this chat. Shell commands still ask."),
		],
		default: GROK_PERMISSION_PRESET_ASK,
		sessionMutable: true,
		chatMutable: true,
	}),
});

export function readPermissionPreset(values: Record<string, unknown> | undefined): typeof GROK_PERMISSION_PRESET_ASK | typeof GROK_PERMISSION_PRESET_ALLOW_EDITS {
	return values?.[GROK_PERMISSION_PRESET_KEY] === GROK_PERMISSION_PRESET_ALLOW_EDITS
		? GROK_PERMISSION_PRESET_ALLOW_EDITS
		: GROK_PERMISSION_PRESET_ASK;
}

export function modeIdForSessionMode(mode: unknown): typeof GROK_PLAN_MODE_ID | typeof GROK_DEFAULT_MODE_ID | undefined {
	if (mode === 'plan') {
		return GROK_PLAN_MODE_ID;
	}
	if (mode === 'interactive') {
		return GROK_DEFAULT_MODE_ID;
	}
	return undefined;
}

export interface IGrokPermissionTarget {
	readonly kind?: string;
	readonly name?: string;
	readonly permissionKind?: string;
}

function normalized(value: string | undefined): string {
	return (value ?? '').toLowerCase();
}

export function isShellPermissionTarget(target: IGrokPermissionTarget): boolean {
	const kind = normalized(target.kind);
	const name = normalized(target.name);
	return SHELL_KINDS.has(kind) || SHELL_NAMES.has(name) || target.permissionKind === 'shell';
}

export function isEditPermissionTarget(target: IGrokPermissionTarget): boolean {
	if (isShellPermissionTarget(target)) {
		return false;
	}
	const kind = normalized(target.kind);
	const name = normalized(target.name);
	return EDIT_KINDS.has(kind) || EDIT_NAMES.has(name) || target.permissionKind === 'write';
}

/**
 * Auto-approve only the live edit option id. Matching `kind: allow_always`
 * would also select the shell "always allow" option.
 */
export function allowEditsSessionOptionId(
	options: readonly { readonly optionId: string }[],
	target: IGrokPermissionTarget,
): string | undefined {
	if (!isEditPermissionTarget(target)) {
		return undefined;
	}
	return options.find(option => option.optionId === GROK_ALLOW_EDITS_OPTION_ID)?.optionId;
}

export function isSubagentTool(kind: string | undefined, name: string | undefined): boolean {
	return SUBAGENT_KINDS.has(normalized(kind)) || SUBAGENT_NAMES.has(normalized(name));
}

const PLAN_STATUS: Record<string, IGrokTodoItem['status']> = {
	'pending': 'not-started',
	'not-started': 'not-started',
	'in_progress': 'in-progress',
	'in-progress': 'in-progress',
	'completed': 'completed',
};

export function todosFromPlanEntries(entries: unknown): readonly IGrokTodoItem[] {
	if (!Array.isArray(entries)) {
		return [];
	}
	const todos: IGrokTodoItem[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const record = entry as { content?: unknown; title?: unknown; status?: unknown; id?: unknown };
		const title = typeof record.content === 'string' ? record.content
			: typeof record.title === 'string' ? record.title
				: undefined;
		if (!title) {
			continue;
		}
		const status = PLAN_STATUS[typeof record.status === 'string' ? record.status : ''] ?? 'not-started';
		const id = typeof record.id === 'string' || typeof record.id === 'number' ? String(record.id) : String(todos.length + 1);
		todos.push({ id, title, status });
	}
	return todos;
}

/** Best-effort read of a `todo_write` tool input. The live shape is to verify. */
export function todosFromToolInput(rawInput: unknown): readonly IGrokTodoItem[] | undefined {
	if (!rawInput || typeof rawInput !== 'object') {
		return undefined;
	}
	const record = rawInput as { entries?: unknown; todos?: unknown; todoList?: unknown };
	const source = record.entries ?? record.todos ?? record.todoList;
	if (!Array.isArray(source)) {
		return undefined;
	}
	const todos = todosFromPlanEntries(source);
	return todos.length > 0 ? todos : undefined;
}
