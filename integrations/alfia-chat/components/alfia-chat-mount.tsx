"use client";

import { useEffect, useRef, useState } from "react";
import AlfiaChat from "./alfia-chat";

/** The shared logo also appears in the mobile menu and footer. Mount once,
 * in the persistent primary header; the widget itself portals into the body. */
export default function AlfiaChatMount() {
  const marker = useRef<HTMLSpanElement>(null);
  const [isPrimaryHeader, setIsPrimaryHeader] = useState(false);

  useEffect(() => {
    setIsPrimaryHeader(Boolean(marker.current?.closest("a.brand-home")));
  }, []);

  return (
    <>
      <span ref={marker} hidden aria-hidden="true" />
      {isPrimaryHeader ? <AlfiaChat /> : null}
    </>
  );
}
