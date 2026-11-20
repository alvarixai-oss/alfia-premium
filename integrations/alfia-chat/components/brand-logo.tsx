import Image from "next/image";
import "../app/whatsapp-visibility.css";
import AlfiaChatMount from "./alfia-chat-mount";

/** Original brand asset, cropped only by its frame; the image keeps its aspect ratio. */
export default function BrandLogo({ dark = false }: { dark?: boolean }) {
  return (
    <>
      <span className={`brand-logo${dark ? " brand-logo--dark" : ""}`}>
        <Image
          src={dark ? "/brand/logo-dark.png" : "/brand/logo-light.png"}
          alt="Alfia"
          width={dark ? 768 : 767}
          height={dark ? 576 : 578}
          sizes="164px"
          className="brand-logo__image"
          priority={!dark}
        />
      </span>
      {!dark ? <AlfiaChatMount /> : null}
    </>
  );
}
