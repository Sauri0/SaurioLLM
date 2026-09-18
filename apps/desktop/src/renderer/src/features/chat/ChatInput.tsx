// Barra de entrada del chat: texto, selector de modo, enviar/cancelar (doc 04 §16 `run:start`/`run:cancel`)
// — apps/desktop/src/renderer/src/features/chat/ChatInput.tsx.
import { useState } from 'react';
import type { Mode } from '@saurio/shared';
import { ModeSelector } from './ModeSelector.js';
import { CpuIcon } from '../../ui/icons.js';

export interface ChatInputProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  /** `true` mientras hay un run activo para este chat (no en estado terminal) — deshabilita el
   *  envío y habilita cancelar (doc 06 §8: el run queda en `awaiting_permission` sin timeout, se
   *  cancela con `run:cancel` en cualquier momento). */
  isRunning: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  /** Modelo activo del chat (pasada de diseño #5: nombre del modelo + contador de contexto junto
   *  al botón de enviar, para no tener que mirar la barra de estado para saber con qué modelo se
   *  va a mandar el próximo mensaje). */
  modelName: string;
  /** "3.3k / 8k" ya formateado (`ui/formatTokens.ts`), o `undefined` si todavía no hay métricas. */
  contextLabel: string | undefined;
}

export function ChatInput({ mode, onModeChange, isRunning, onSend, onCancel, modelName, contextLabel }: ChatInputProps): React.JSX.Element {
  const [text, setText] = useState('');

  function handleSend(): void {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    onSend(trimmed);
    setText('');
  }

  // Atajo básico (pasada de diseño UI): Ctrl+Enter (o Cmd+Enter en mac) envía; Enter solo agrega
  // una línea nueva, comportamiento estándar de un textarea multilínea.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-input">
      <div className="chat-input__toolbar">
        <ModeSelector mode={mode} disabled={isRunning} onChange={onModeChange} />
      </div>
      <textarea
        className="chat-input__textarea"
        placeholder="Escribí un mensaje… (Ctrl+Enter para enviar)"
        aria-label="Mensaje para el agente"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isRunning}
        rows={3}
      />
      <div className="chat-input__actions">
        <span className="chat-input__hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> para enviar</span>
        <span className="chat-input__model" title="Modelo activo de este chat">
          <CpuIcon width={12} height={12} />
          {modelName}
          {contextLabel && <span className="chat-input__context">· {contextLabel}</span>}
        </span>
        {isRunning ? (
          <button type="button" className="chat-input__cancel" onClick={onCancel}>Cancelar</button>
        ) : (
          <button type="button" className="chat-input__send saurio-btn-primary" onClick={handleSend} disabled={!text.trim()}>Enviar</button>
        )}
      </div>
    </div>
  );
}
