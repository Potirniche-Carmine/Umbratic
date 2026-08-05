//! Editor and file-manager marks for the "Open in…" menu.
//!
//! Pure presentational SVG, no state and no props beyond the usual SVG ones, so
//! it lives apart from the app shell.

import { FolderOpen } from "lucide-react";
import React from "react";

import type { IdeInfo } from "../shared/desktopApi";

function VsCodeLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" {...props}>
      <mask id="vscodeMask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <path
          fill="#fff"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M70.9 99.3a6.2 6.2 0 0 0 5-.2L96 89.5a6.3 6.3 0 0 0 3.6-5.7V16.2a6.3 6.3 0 0 0-3.6-5.7L75.9 1A6.3 6.3 0 0 0 68.7 2L30.2 37.1 13.4 24.4a4.2 4.2 0 0 0-5.4.2L2.6 29.5a4.2 4.2 0 0 0 0 6.2L17.2 50 2.6 64.3a4.2 4.2 0 0 0 0 6.2L8 75.4a4.2 4.2 0 0 0 5.4.2l16.8-12.7L68.7 98a6.3 6.3 0 0 0 2.2 1.3Zm4.4-72.4L46.1 50l29.2 23.1V26.9Z"
        />
      </mask>
      <g mask="url(#vscodeMask)">
        <path fill="#0065A9" d="M96.1 10.5 75.9 1A6.3 6.3 0 0 0 68.7 2L2.5 64.3a4.2 4.2 0 0 0 0 6.2L8 75.4a4.2 4.2 0 0 0 5.4.2l79.7-60.4a4.2 4.2 0 0 1 6.7 3.3v-.2a6.3 6.3 0 0 0-3.7-5.8Z" />
        <path fill="#007ACC" d="m96.1 89.5-20.2 9.6a6.3 6.3 0 0 1-7.2-1L2.5 35.7a4.2 4.2 0 0 1 0-6.2L8 24.6a4.2 4.2 0 0 1 5.4-.2l79.7 60.4a4.2 4.2 0 0 0 6.7-3.3v.2a6.3 6.3 0 0 1-3.7 5.8Z" />
        <path fill="#1F9CF0" d="M75.9 99.1A6.3 6.3 0 0 1 68.7 98c2.1 2 5.5.6 5.5-2.4V4.4c0-3-3.4-4.4-5.5-2.4A6.3 6.3 0 0 1 75.9 1L96 10.5a6.3 6.3 0 0 1 3.6 5.7v67.6a6.3 6.3 0 0 1-3.6 5.7l-20.2 9.6Z" />
      </g>
    </svg>
  );
}

function VisualStudioLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id="vsGrad" x1="2" y1="12" x2="22" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#52218a" />
          <stop offset=".5" stopColor="#682dac" />
          <stop offset="1" stopColor="#9b4ddc" />
        </linearGradient>
      </defs>
      <path fill="url(#vsGrad)" d="M16.7 2.5 22 4.6v14.8l-5.3 2.1-7.4-7.1-5.3 4.1L2 17.2V6.8L4 5.5l5.3 4.1 7.4-7.1Z" />
      <path fill="#fff" d="M16.7 7.4 11.7 12l5 4.6V7.4ZM4 9.5v5l3-2.5L4 9.5Z" />
    </svg>
  );
}

function ExplorerLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id="folderTop" x1="12" y1="5" x2="12" y2="9" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f0a93a" />
          <stop offset="1" stopColor="#d68a1a" />
        </linearGradient>
        <linearGradient id="folderFront" x1="12" y1="9" x2="12" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffd06b" />
          <stop offset="1" stopColor="#e8a83a" />
        </linearGradient>
      </defs>
      <path fill="url(#folderTop)" d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6a2 2 0 0 1 1.5.7L12 7.5h6.8A2.2 2.2 0 0 1 21 9.7v1.6H3V7.2Z" />
      <path fill="url(#folderFront)" d="M3 10.4h18v6.4a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 16.8v-6.4Z" />
      <path fill="#ffffff" opacity=".18" d="M3 10.4h18v1.2H3z" />
    </svg>
  );
}

function FinderLogo(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <path fill="#38a8ff" d="M4.2 3.2h7.6v17.6H5.8a2.6 2.6 0 0 1-2.6-2.6V4.2a1 1 0 0 1 1-1Z" />
      <path fill="#d8f0ff" d="M11.8 3.2h8a1 1 0 0 1 1 1v14a2.6 2.6 0 0 1-2.6 2.6h-6.4V3.2Z" />
      <path fill="#14304a" d="M8 8.4a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Zm8 0a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z" />
      <path fill="none" stroke="#14304a" strokeLinecap="round" strokeWidth="1.2" d="M9 15.4c1.7 1 4.3 1 6 0M11.8 4.5c-.6 2.8-.6 5.6 0 8.4" />
    </svg>
  );
}

export function IdeIcon({ icon }: { icon: IdeInfo["icon"] }) {
  if (icon === "vscode") return <VsCodeLogo className="ideLogo" />;
  if (icon === "visualstudio") return <VisualStudioLogo className="ideLogo" />;
  if (icon === "finder") return <FinderLogo className="ideLogo" />;
  if (icon === "files") return <FolderOpen className="ideLogo" />;
  return <ExplorerLogo className="ideLogo" />;
}
