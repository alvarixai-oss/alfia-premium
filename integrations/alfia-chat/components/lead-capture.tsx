"use client";

import { useState, type FormEvent } from "react";

export default function LeadCapture({ language }: { language: "es" | "en" }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const isEs = language === "es";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    if (!email && !phone) { setError(isEs ? "Indica un teléfono o correo." : "Provide an email or phone."); return; }
    if (data.get("consent") !== "on") { setError(isEs ? "Necesitamos tu consentimiento." : "Consent is required."); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: data.get("fullName"),
          companyName: data.get("companyName"),
          email, phone,
          requestedService: data.get("requestedService"),
          businessNeed: data.get("businessNeed"),
          leadIntent: "information",
          contactPreference: "unspecified",
          consent: true,
          consentVersion: "alfia-leads-v1",
          website: data.get("website"),
        }),
      });
      if (!response.ok) throw new Error("save_failed");
      setSaved(true);
    } catch {
      setError(isEs
        ? "No se ha podido guardar el contacto. Puedes contactar por WhatsApp o llamar."
        : "We could not save your details. Please contact us by WhatsApp or phone.");
    } finally {
      setBusy(false);
    }
  };

  if (saved) return <p role="status">{isEs ? "Datos recibidos. El equipo podrá revisar tu solicitud." : "Details received. Our team can review your request."}</p>;
  return <div style={{ marginTop: 12 }}>
    {!open
      ? <button type="button" onClick={() => setOpen(true)}>{isEs ? "Dejar mis datos para seguimiento" : "Leave my contact details"}</button>
      : <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
          <label>{isEs ? "Nombre" : "Name"} <input name="fullName" maxLength={120} autoComplete="name" /></label>
          <label>{isEs ? "Empresa" : "Company"} <input name="companyName" maxLength={160} autoComplete="organization" /></label>
          <label>{isEs ? "Correo" : "Email"} <input name="email" type="email" maxLength={254} autoComplete="email" /></label>
          <label>{isEs ? "Teléfono" : "Phone"} <input name="phone" type="tel" maxLength={40} autoComplete="tel" /></label>
          <label>{isEs ? "Servicio que te interesa" : "Interested service"} <input name="requestedService" maxLength={160} /></label>
          <label>{isEs ? "Breve descripción de tu necesidad (opcional)" : "Your business need (optional)"}
            <textarea name="businessNeed" maxLength={600} rows={2}/></label>
          <label style={{ display: "none" }} aria-hidden="true">Website <input name="website" tabIndex={-1} autoComplete="off" /></label>
          <label><input type="checkbox" name="consent" required /> {isEs
            ? "Acepto que Alfia utilice estos datos para responder a mi solicitud comercial. No es obligatorio dejarlos para contactar por WhatsApp."
            : "I agree that Alfia may use these details to follow up on my business enquiry. Providing them is optional to contact via WhatsApp."}
          </label>
          <a href="/privacidad" target="_blank" rel="noopener noreferrer">{isEs ? "Política de privacidad" : "Privacy policy"}</a>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? (isEs ? "Guardando..." : "Saving...") : (isEs ? "Enviar mis datos" : "Submit details")}</button>
        </form>}
  </div>;
}
