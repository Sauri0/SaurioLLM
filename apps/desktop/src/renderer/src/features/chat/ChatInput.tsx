// Compositor del chat: texto, adjuntos, menús de modo/potencia/permisos, modelo+contexto y
// enviar/cancelar — rediseño del chat, punto 1 (doc 04 §16 `run:start`/`run:cancel`).
// apps/desktop/src/renderer/src/features/chat/ChatInput.tsx.
import { useEffect, useRef, useState } from 'react';
import type { Attachment, ChatPermissionPreset, Effort, Mode } from '@saurio/shared';
import { ModeMenu, EffortMenu, PermissionMenu } from './ComposerMenus.js';
import { fileToAttachment, formatAttachmentSize, MAX_ATTACHMENT_BYTES } from './attachments.js';
import { CpuIcon, PaperclipIcon, ImageIcon, FileIcon, CloseIcon } from '../../ui/icons.js';

/** Alto máximo del textarea autoexpansivo antes de empezar a scrollear en vez de seguir creciendo
 *  (rediseño del chat, punto 1: "textarea que crece") — deja lugar para el resto del compositor y
 *  la lista de mensajes en la ventana mínima de 960x600. */
const TEXTAREA_MAX_HEIGHT_PX = 200;

export interface ChatInputProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  effort: Effort;
  onEffortChange: (effort: Effort) => void;
  permissionPreset: ChatPermissionPreset;
  onPermissionPresetChange: (preset: ChatPermissionPreset, confirmed?: boolean) => void;
  /** `true` mientras hay un run activo para este chat (no en estado terminal) — deshabilita el
   *  envío y habilita cancelar (doc 06 §8: el run queda en `awaiting_permission` sin timeout, se
   *  cancela con `run:cancel` en cualquier momento). */
  isRunning: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onCancel: () => void;
  /** Modelo activo del chat (pasada de diseño #5: nombre del modelo + contador de contexto junto
   *  al botón de enviar, para no tener que mirar la barra de estado para saber con qué modelo se
   *  va a mandar el próximo mensaje). */
  modelName: string;
  /** "3.3k / 8k" ya formateado con el numCtx REAL (`ui/formatTokens.ts`), nunca el máximo teórico
   *  del modelo — o `undefined` si todavía no hay métricas. */
  contextLabel: string | undefined;
}

export function ChatInput({
  mode, onModeChange, effort, onEffortChange, permissionPreset, onPermissionPresetChange,
  isRunning, onSend, onCancel, modelName, contextLabel,
}: ChatInputProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Textarea que crece con el contenido (rediseño del chat, punto 1) hasta TEXTAREA_MAX_HEIGHT_PX;
  // de ahí en más scrollea adentro en vez de seguir empujando el resto del compositor.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [text]);

  async function addFiles(files: FileList | File[]): Promise<void> {
    setAttachError(undefined);
    const list = Array.from(files);
    const oversized = list.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const accepted = list.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
    if (oversized.length > 0) {
      setAttachError(`${oversized.length === 1 ? 'Un archivo pesa' : `${oversized.length} archivos pesan`} más de 10 MB y no se adjuntó.`);
    }
    if (accepted.length === 0) return;
    const converted = await Promise.all(accepted.map((f) => fileToAttachment(f)));
    setAttachments((prev) => [...prev, ...converted]);
  }

  function removeAttachment(index: number): void {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSend(): void {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || isRunning) return;
    onSend(trimmed, attachments);
    setText('');
    setAttachments([]);
    setAttachError(undefined);
  }

  // Rediseño del chat, punto 1 (feedback real v0.2.1: "Enter no envía"): Enter solo envía (como
  // Claude Code/Codex); Shift+Enter agrega una línea nueva; Ctrl+Enter (o Cmd+Enter en mac) se
  // mantiene como atajo alternativo por compatibilidad con el hábito anterior de esta app.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return; // línea nueva, comportamiento nativo del textarea
    e.preventDefault();
    handleSend();
  }

  // "también pegar imagen" (punto 1 del encargo): una imagen copiada al portapapeles llega acá como
  // un `File` sintético en `clipboardData.items`, no como texto — se intercepta antes de que el
  // textarea intente pegarla como texto plano (que fallaría silenciosamente para un blob de imagen).
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
  }

  return (
    <div
      className={`chat-input${dragOver ? ' chat-input--drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <ul className="chat-input__attachments">
          {attachments.map((a, i) => (
            <li key={`${a.name}-${i}`} className="chat-input__attachment-chip">
              {a.kind === 'image' ? <ImageIcon width={12} height={12} /> : <FileIcon width={12} height={12} />}
              <span className="chat-input__attachment-name">{a.name}</span>
              <span className="chat-input__attachment-size">{formatAttachmentSize(a.sizeBytes)}</span>
              <button
                type="button"
                className="chat-input__attachment-remove"
                onClick={() => removeAttachment(i)}
                aria-label={`Quitar adjunto ${a.name}`}
              >
                <CloseIcon width={10} height={10} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachError && <p className="chat-input__attach-error" role="alert">{attachError}</p>}
      <textarea
        ref={textareaRef}
        className="chat-input__textarea"
        placeholder="Escribí un mensaje… (Enter para enviar, Shift+Enter para bajar de renglón)"
        aria-label="Mensaje para el agente"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={isRunning}
        rows={1}
      />
      {dragOver && <div className="chat-input__drop-hint">Soltá para adjuntar</div>}
      <div className="chat-input__toolbar">
        <button
          type="button"
          className="chat-input__attach-button"
          title="Adjuntar archivos o imágenes"
          onClick={() => fileInputRef.current?.click()}
          disabled={isRunning}
        >
          <PaperclipIcon width={14} height={14} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-input__file-input"
          onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
        />
        <ModeMenu mode={mode} disabled={isRunning} onChange={onModeChange} />
        <EffortMenu effort={effort} disabled={isRunning} onChange={onEffortChange} />
        <PermissionMenu preset={permissionPreset} disabled={isRunning} onChange={onPermissionPresetChange} />
        <span className="chat-input__spacer" />
        <span className="chat-input__model" title="Modelo activo de este chat — el contexto es el numCtx real, no el máximo teórico">
          <CpuIcon width={12} height={12} />
          {modelName}
          {contextLabel && <span className="chat-input__context">· {contextLabel}</span>}
        </span>
      </div>
      <div className="chat-input__actions">
        <span className="chat-input__hint"><kbd>Enter</kbd> envía · <kbd>Shift</kbd>+<kbd>Enter</kbd> nueva línea</span>
        {isRunning ? (
          <button type="button" className="chat-input__cancel" onClick={onCancel}>Detener</button>
        ) : (
          <button
            type="button"
            className="chat-input__send saurio-btn-primary"
            onClick={handleSend}
            disabled={!text.trim() && attachments.length === 0}
          >
            Enviar
          </button>
        )}
      </div>
    </div>
  );
}
