import Script from "next/script";

// The dashboard is plain browser JavaScript in public/dashboard.js, so it can be
// edited without touching React. This page just provides the mount point.
export default function Page() {
  return (
    <>
      <div id="app" />
      <Script src="/dashboard.js" strategy="afterInteractive" />
    </>
  );
}
