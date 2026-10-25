import type { ReactElement } from "react";

const PATHS = {
  "arrow-left": <path d="M19 12H5M11 6l-6 6 6 6" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  bridge: (
    <>
      <path d="M6 21V10M18 21V10M6 15c4-4 8-4 12 0" />
      <circle cx="6" cy="6.5" r="1.6" />
      <circle cx="18" cy="6.5" r="1.6" />
      <path strokeWidth="1.5" d="M3.3 4a3.6 3.6 0 0 0 0 5M8.7 4a3.6 3.6 0 0 1 0 5M15.3 4a3.6 3.6 0 0 0 0 5M20.7 4a3.6 3.6 0 0 1 0 5" />
    </>
  ),
  chart: <path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  drive: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 18 4-6" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01" />
    </>
  ),
  joystick: (
    <>
      <rect x="4" y="15" width="16" height="5" rx="2" />
      <path d="M12 15V9" />
      <circle cx="12" cy="6" r="3" />
    </>
  ),
  left: <path d="M19 12H5M11 6l-6 6 6 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
      <circle cx="12" cy="10" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  radio: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
    </>
  ),
  record: <circle cx="12" cy="12" r="5" />,
  right: <path d="M5 12h14M13 6l6 6-6 6" />,
  robot: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M2 13v3M22 13v3" />
    </>
  ),
  "rot-l": (
    <>
      <path d="M4 4v6h6" />
      <path d="M4.5 10A8 8 0 1 1 6 17" />
    </>
  ),
  "rot-r": (
    <>
      <path d="M20 4v6h-6" />
      <path d="M19.5 10A8 8 0 1 0 18 17" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  usb: (
    <>
      <path d="M12 3v14" />
      <path d="M12 3l-2.5 3M12 3l2.5 3" />
      <path d="M12 12l4-2V7.5" />
      <path d="M12 14l-4-2v-1.5" />
      <circle cx="16" cy="6" r="1.2" />
      <rect x="6.8" y="8.6" width="2.4" height="2.4" />
      <circle cx="12" cy="19" r="2" />
    </>
  ),
  wifi: (
    <>
      <path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19.5" r=".8" />
    </>
  ),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `ic ${className}` : "ic"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}

export function StopOctagon({ size = 24, letter, className }: { size?: number; letter?: string; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <polygon className="lg-oct" points="8,2 16,2 22,8 22,16 16,22 8,22 2,16 2,8" />
      {letter && (
        <text className="lg-oct-e" x="12" y="16" textAnchor="middle">
          {letter}
        </text>
      )}
    </svg>
  );
}
