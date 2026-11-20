"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import styles from "./alfia-chat.module.css";

type Language = "es" | "en";
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  handoff?: boolean;
};
type WireMessage = Pick<Message, "role" | "content">;
type StreamEvent = { type: string; text?: string; message?: string };

const MAX_INPUT = 1200;
const PHONE = "+34 679 17 66 67";
const copy = {
  es: {
    open: "Abrir el asistente de Alfia", close: "Cerrar el chat", title: "Asistente Alfia",
    subtitle: "IA para ayudarte", welcome: "Hola, soy el asistente virtual de Alfia.",
    welcomeDetail: "¿Qué te gustaría simplificar en tu empresa?", placeholder: "Escribe tu pregunta…",
    inputLabel: "Tu pregunta para Alfia", send: "Enviar mensaje", writing: "Alfia está escribiendo…",
    privacy: "Asistente de IA. Consulta nuestra", privacyLink: "política de privacidad", processor: "Mensajes procesados por OpenAI.",
    privacyDetail: "El historial se mantiene solo mientras navegas en esta página.",
    reset: "Empezar una nueva conversación", you: "Tú", assistant: "Alfia",
    call: "Llamar ahora", contact: "Habla con el equipo", newReply: "Alfia ha respondido.",
    error: "Ahora mismo no puedo responder. El equipo de Alfia puede ayudarte directamente.",
    retry: "Puedes intentarlo de nuevo o hablar con el equipo.",
    suggestions: ["¿Qué servicios ofrecéis?", "Quiero automatizar mi correo", "¿Cómo funciona la Recepción IA?", "Quiero hablar con una persona"],
  },
  en: {
    open: "Open the Alfia assistant", close: "Close chat", title: "Alfia assistant",
    subtitle: "AI here to help", welcome: "Hello, I’m Alfia’s virtual assistant.",
    welcomeDetail: "What would you like to simplify in your business?", placeholder: "Type your question…",
    inputLabel: "Your question for Alfia", send: "Send message", writing: "Alfia is typing…",
    privacy: "AI assistant. Read our", privacyLink: "privacy policy", processor: "Messages processed by OpenAI.",
    privacyDetail: "Your history stays only while you browse this page.",
    reset: "Start a new conversation", you: "You", assistant: "Alfia",
    call: "Call now", contact: "Talk to the team", newReply: "Alfia has replied.",
    error: "I can’t reply right now. The Alfia team can help you directly.",
    retry: "You can try again or speak to the team.",
    suggestions: ["What services do you offer?", "I want to automate my email", "How does AI Reception work?", "I’d like to speak to a person"],
  },
};

function Icon({ kind }: { kind: "close" | "send" | "reset" | "phone" | "whatsapp" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "close" && <path d="m6 6 12 12M18 6 6 18" />}
      {kind === "send" && <><path d="m4 11 16-7-7 16-2-7-7-2Z" /><path d="m11 13 9-9" /></>}
      {kind === "reset" && <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" /></>}
      {kind === "phone" && <path d="M8 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 2a14 14 0 0 1-6-6l2-2-2-5Z" />}
      {kind === "whatsapp" && <><path d="M21 11.5a9 9 0 0 1-13.3 8L3 21l1.5-4.7A9 9 0 1 1 21 11.5Z" /><path d="m8 7 2 3-1 1c1 2 2 3 4 4l1-1 3 1c-1 3-3 2-5 1-3-2-5-4-5-6 0-2 1-3 1-3Z" /></>}
    </svg>
  );
}

function ContactOptions({ language }: { language: Language }) {
  const t = copy[language];
  return (
    <div className={styles.contact}>
      <span className={styles.contactTitle}>{t.contact} · {PHONE}</span>
      <div className={styles.contactActions}>
        <a href="tel:+34679176667" className={styles.call}><Icon kind="phone" />{t.call}</a>
        <a href="https://wa.me/34679176667" target="_blank" rel="noopener noreferrer" className={styles.whatsapp} aria-label={language === "es" ? "Hablar por WhatsApp (se abre en otra pestaña)" : "Chat on WhatsApp (opens in a new tab)"}><Icon kind="whatsapp" />WhatsApp</a>
      </div>
    </div>
  );
}

/** Keep the request bounded; the visible history remains in this component's memory. */
function requestHistory(messages: Message[]): WireMessage[] {
  const selected: WireMessage[] = [];
  let length = 0;
  for (let i = messages.length - 1; i >= 0 && selected.length < 11; i -= 1) {
    const message = messages[i];
    if (!message.content) continue;
    const content = message.content.slice(0, 2000);
    if (length + content.length > 10000) break;
    selected.unshift({ role: message.role, content });
    length += content.length;
  }
  while (selected.length > 1 && new TextEncoder().encode(JSON.stringify(selected)).length > 28000) selected.shift();
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

function parseFrame(frame: string): StreamEvent | null {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!data) return null;
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return null;
  return value as StreamEvent;
}

export default function AlfiaChat() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<Language>("es");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [viewport, setViewport] = useState({ height: 0, bottom: 0 });
  const panelId = useId();
  const headingId = useId();
  const disclosureId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const pending = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);
  const messageNumber = useRef(0);
  const busyRef = useRef(false);
  const t = copy[language];

  useEffect(() => {
    setMounted(true);
    const pageLanguage = document.documentElement.lang || navigator.language;
    setLanguage(pageLanguage.toLowerCase().startsWith("en") ? "en" : "es");
    const updateViewport = () => {
      const visual = window.visualViewport;
      setViewport({ height: visual?.height ?? window.innerHeight, bottom: visual ? Math.max(0, window.innerHeight - visual.height - visual.offsetTop) : 0 });
    };
    updateViewport();
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      requestNumber.current += 1;
      pending.current?.abort();
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    // Focus the conversation on touch screens without forcing the keyboard open.
    if (window.matchMedia("(pointer: coarse)").matches) document.getElementById(panelId)?.focus({ preventScroll: true });
    else field.current?.focus({ preventScroll: true });
  }, [open, panelId]);

  useEffect(() => {
    if (open && followMessages.current && scrollArea.current) scrollArea.current.scrollTop = messages.length ? scrollArea.current.scrollHeight : 0;
  }, [messages, busy, open]);

  const close = () => {
    setOpen(false);
    // The compact keyboard layout hides the launcher while the panel is open.
    requestAnimationFrame(() => launcher.current?.focus({ preventScroll: true }));
  };

  const reset = () => {
    requestNumber.current += 1;
    pending.current?.abort();
    pending.current = null;
    busyRef.current = false;
    setBusy(false);
    setMessages([]);
    setInput("");
    setAnnouncement("");
    followMessages.current = true;
    field.current?.focus({ preventScroll: true });
  };

  const send = async (value: string) => {
    const text = value.trim();
    if (!text || text.length > MAX_INPUT || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setInput("");
    setAnnouncement(t.writing);
    followMessages.current = true;
    const user: Message = { id: `alfia-message-${++messageNumber.current}`, role: "user", content: text };
    const answerId = `alfia-message-${++messageNumber.current}`;
    const conversation = [...messages, user];
    setMessages([...conversation, { id: answerId, role: "assistant", content: "" }]);
    const controller = new AbortController();
    pending.current = controller;
    const activeRequest = ++requestNumber.current;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 40000);
    let receivedDone = false;
    let answer = "";
    const updateAnswer = (change: Partial<Message>) => {
      if (requestNumber.current === activeRequest) setMessages(current => current.map(message => message.id === answerId ? { ...message, ...change } : message));
    };
    const consume = (event: StreamEvent | null) => {
      if (!event) return;
      if (event.type === "delta" && typeof event.text === "string") {
        answer += event.text;
        if (answer.length > 16000) throw new Error("Response too long");
        updateAnswer({ content: answer });
      } else if (event.type === "handoff") {
        updateAnswer({ handoff: true });
      } else if (event.type === "error") {
        answer = typeof event.message === "string" ? event.message : t.error;
        updateAnswer({ content: answer, handoff: true });
      } else if (event.type === "done") receivedDone = true;
    };
    try {
      const response = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ messages: requestHistory(conversation), locale: language }),
        signal: controller.signal, cache: "no-store",
      });
      if (!response.ok) {
        let message = t.error;
        try {
          const failure: unknown = await response.json();
          if (failure && typeof failure === "object" && "error" in failure && typeof failure.error === "string") message = failure.error;
        } catch { /* Keep the friendly fallback for non-JSON errors. */ }
        updateAnswer({ content: message, handoff: true });
        receivedDone = true;
      } else {
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Missing event stream");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!receivedDone) {
            const part = await reader.read();
            buffer += decoder.decode(part.value, { stream: !part.done });
            let separator = /\r?\n\r?\n/.exec(buffer);
            while (separator) {
              consume(parseFrame(buffer.slice(0, separator.index)));
              buffer = buffer.slice(separator.index + separator[0].length);
              separator = /\r?\n\r?\n/.exec(buffer);
            }
            if (buffer.length > 64000) throw new Error("Invalid event stream");
            if (part.done) {
              if (buffer.trim()) consume(parseFrame(buffer));
              break;
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        if (!receivedDone) throw new Error("Incomplete response");
        if (!answer.trim()) updateAnswer({ content: t.error, handoff: true });
      }
      if (activeRequest === requestNumber.current) setAnnouncement(t.newReply);
    } catch {
      if (activeRequest === requestNumber.current && (!controller.signal.aborted || timedOut)) {
        updateAnswer({ content: answer.trim() ? `${answer}\n\n${t.error}` : t.error, handoff: true });
        setAnnouncement(t.error);
      }
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest === requestNumber.current) {
        busyRef.current = false;
        pending.current = null;
        setBusy(false);
      }
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(input);
  };

  if (!mounted) return null;
  const compact = open && viewport.height > 0 && viewport.height < 440;
  const verySmall = compact && viewport.height < 220;
  const viewportStyle = {
    "--chat-viewport-height": viewport.height ? `${viewport.height}px` : "100dvh",
    "--chat-keyboard-offset": `${viewport.bottom}px`,
  } as CSSProperties;

  return createPortal(
    <div className={`${styles.root} ${compact ? styles.compact : ""} ${verySmall ? styles.verySmall : ""}`} style={viewportStyle} onClick={event => event.stopPropagation()} onKeyDown={event => { if (open && event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); } }}>
      <span role="status" aria-live="polite" aria-atomic="true" className={styles.srOnly}>{announcement}</span>
      {open && (
        <section id={panelId} className={styles.panel} role="dialog" aria-modal="false" aria-labelledby={headingId} aria-describedby={disclosureId} tabIndex={-1}>
          <header className={styles.header}>
            <span className={styles.headerAvatar}><img src="/brand/alfia-assistant.png" alt="" width="52" height="52" /></span>
            <div className={styles.heading}><h2 id={headingId}>{t.title}</h2><p><span className={styles.statusDot} />{t.subtitle}</p></div>
            <button type="button" className={styles.iconButton} onClick={reset} aria-label={t.reset} title={t.reset}><Icon kind="reset" /></button>
            <button type="button" className={styles.iconButton} onClick={close} aria-label={t.close} title={t.close}><Icon kind="close" /></button>
          </header>
          <div className={styles.messages} ref={scrollArea} onScroll={() => { const el = scrollArea.current; if (el) followMessages.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-label={language === "es" ? "Conversación con Alfia" : "Conversation with Alfia"}>
            <div className={styles.welcome}><strong>{t.welcome}</strong><p>{t.welcomeDetail}</p></div>
            {messages.length === 0 && <div className={styles.suggestions}>{t.suggestions.map(suggestion => <button type="button" key={suggestion} onClick={() => void send(suggestion)} disabled={busy}>{suggestion}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10" /></svg></button>)}</div>}
            {messages.map((message, index) => (
              <div key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
                <span className={styles.speaker}>{message.role === "user" ? t.you : t.assistant}</span>
                {message.content && <div className={styles.messageText}>{message.content}</div>}
                {busy && index === messages.length - 1 && !message.content && <span className={styles.typing} aria-label={t.writing}><i /><i /><i /></span>}
                {message.handoff && <ContactOptions language={language} />}
              </div>
            ))}
          </div>
          <div className={styles.composerArea}>
            <form className={styles.composer} onSubmit={submit}>
              <label className={styles.srOnly} htmlFor={`${panelId}-input`}>{t.inputLabel}</label>
              <textarea id={`${panelId}-input`} ref={field} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} placeholder={t.placeholder} maxLength={MAX_INPUT} rows={2} autoComplete="off" enterKeyHint="send" />
              <button type="submit" className={styles.send} disabled={busy || !input.trim()} aria-label={t.send}><Icon kind="send" /></button>
            </form>
            <div className={styles.composerMeta}><span>{busy ? t.writing : ""}</span><span aria-hidden="true">{input.length}/{MAX_INPUT}</span></div>
            <p id={disclosureId} className={styles.disclosure}>{t.privacy} <a href="/privacidad" target="_blank" rel="noopener noreferrer">{t.privacyLink}</a>. <span title={t.privacyDetail}>{t.processor} {language === "es" ? "No guardamos el historial en la web." : "We don’t save chat history on the website."}</span></p>
          </div>
        </section>
      )}
      <button ref={launcher} type="button" className={`${styles.launcher} ${open ? styles.launcherOpen : ""}`} onClick={() => { if (open) close(); else { followMessages.current = true; setOpen(true); } }} aria-label={open ? t.close : t.open} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog">
        {open ? <Icon kind="close" /> : <><img src="/brand/alfia-assistant.png" alt="" width="76" height="76" /><span className={styles.launcherBadge} aria-hidden="true">IA</span></>}
      </button>
    </div>,
    document.body,
  );
}
