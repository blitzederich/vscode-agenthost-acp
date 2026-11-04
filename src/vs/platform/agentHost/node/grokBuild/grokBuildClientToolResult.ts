/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolResultContentType, type ToolCallResult, type ToolResultContent, type ToolResultEmbeddedResourceContent } from '../../common/state/protocol/channels-chat/state.js';

/**
 * MCP `tools/call` result content block. Kept local so the Grok Build
 * provider does not depend on `@modelcontextprotocol/sdk` at runtime.
 */
export type GrokMcpToolResultContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: string; readonly mimeType: string }
	| { readonly type: 'resource'; readonly resource: { readonly uri: string; readonly mimeType: string; readonly blob: string } };

export interface GrokMcpCallToolResult {
	readonly content: readonly GrokMcpToolResultContent[];
	readonly structuredContent?: Record<string, unknown>;
	readonly isError?: boolean;
}

/** Opaque URI scheme for non-image embedded resources returned to grok. */
const GROK_CLIENT_RESOURCE_SCHEME = 'grok-client';

/**
 * Convert a protocol {@link ToolCallResult} into the MCP tools/call result
 * shape returned over the Grok Build client-tools HTTP MCP server.
 */
export function convertToolCallResult(result: ToolCallResult, toolCallId: string): GrokMcpCallToolResult {
	const blocks = result.content ?? [];
	const content = blocks.map((block, index) => convertBlock(block, toolCallId, index));
	return {
		content,
		...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
		...(!result.success || result.error ? { isError: true } : {}),
	};
}

function convertBlock(block: ToolResultContent, toolCallId: string, index: number): GrokMcpToolResultContent {
	switch (block.type) {
		case ToolResultContentType.Text:
			return { type: 'text', text: block.text };
		case ToolResultContentType.EmbeddedResource:
			return convertEmbeddedResource(block, toolCallId, index);
		case ToolResultContentType.Resource:
		case ToolResultContentType.FileEdit:
		case ToolResultContentType.Terminal:
		case ToolResultContentType.Subagent: {
			// MCP has no native client-tool shapes for these; degrade to text.
			let text: string;
			try {
				text = JSON.stringify(block);
			} catch {
				text = `[unserializable ${block.type} block]`;
			}
			return { type: 'text', text };
		}
		default: {
			const _exhaustive: never = block;
			void _exhaustive;
			return { type: 'text', text: '[unknown tool-result block]' };
		}
	}
}

function convertEmbeddedResource(
	block: ToolResultEmbeddedResourceContent,
	toolCallId: string,
	index: number,
): GrokMcpToolResultContent {
	if (block.contentType.startsWith('image/')) {
		return { type: 'image', data: block.data, mimeType: block.contentType };
	}
	const uri = `${GROK_CLIENT_RESOURCE_SCHEME}://${encodeURIComponent(toolCallId)}/${index}`;
	return {
		type: 'resource',
		resource: { uri, mimeType: block.contentType, blob: block.data },
	};
}
