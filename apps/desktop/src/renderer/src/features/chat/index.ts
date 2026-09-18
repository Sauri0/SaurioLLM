// Panel "chat" del renderer (doc 02 §1 y §2: apps/desktop/src/renderer/src/features/chat/).
// `ChatPanel` es el componente compuesto que monta el layout (doc 04: "Exportá componentes para
// que el layout monte"); el resto se exporta por si el layout necesita recomponer la vista distinto.
export { ChatPanel, type ChatPanelProps } from './ChatPanel.js';
export { ChatHeader, type ChatHeaderProps } from './ChatHeader.js';
export { ChatMessageList, type ChatMessageListProps } from './ChatMessageList.js';
export { ChatInput, type ChatInputProps } from './ChatInput.js';
export { MessageBubble, type MessageBubbleProps } from './MessageBubble.js';
export { MessageMetrics, type MessageMetricsProps } from './MessageMetrics.js';
export { ToolCallCard, type ToolCallCardProps } from './ToolCallCard.js';
export { DelegationCard, type DelegationCardProps } from './DelegationCard.js';
export { CheckpointCard, type CheckpointCardProps } from './CheckpointCard.js';
export { InterruptedRunCard, type InterruptedRunCardProps } from './InterruptedRunCard.js';
export { ModeSelector, type ModeSelectorProps } from './ModeSelector.js';
