// Line icons for the workbench, drawn to the baseline's spec (17px box, 1.7 stroke, round caps).
// Icons always sit next to a label or have an aria-label; they never carry meaning alone.
import type { Role } from './api.ts';

type P = { className?: string };
const svg = (d: React.ReactNode, cls = 'icon') => ({ className }: P) => (
  <svg className={className ?? cls} viewBox="0 0 24 24" aria-hidden="true">{d}</svg>
);

export const IconPlan = svg(<><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>);
export const IconImage = svg(<><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M5 17l4.5-4.5 3.5 3 2.5-2L19 17" /></>);
export const IconStar = svg(<path d="M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.8l5-.7z" />);
export const IconPen = svg(<><path d="M4 20l4.5-1 9-9a2.1 2.1 0 0 0-3-3l-9 9z" /><path d="M14 6.5l3.5 3.5" /></>);
export const IconCode = svg(<><path d="M9 7.5L4.5 12 9 16.5M15 7.5L19.5 12 15 16.5" /></>);
export const IconShield = svg(<><path d="M12 3.5l7 2.5v5.5c0 4-3 7-7 9-4-2-7-5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>);
export const IconLayers = svg(<><path d="M12 4l8 4-8 4-8-4z" /><path d="M4.5 12.5L12 16l7.5-3.5" /></>);
export const IconLock = svg(<><rect x="5" y="10.5" width="14" height="9" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 1 1 7 0v2.5" /></>);
export const IconCheck = svg(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconInfo = svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>);
export const IconClock = svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IconDoc = svg(<><path d="M6 3.5h7l5 5v12H6z" /><path d="M13 3.5V9h5" /></>);
export const IconCursor = svg(<path d="M6 4l12 7-5 1.5L10.5 18z" />);
export const IconEye = svg(<><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></>);
export const IconColumns = svg(<><rect x="3.5" y="5" width="7" height="14" rx="1.6" /><rect x="13.5" y="5" width="7" height="14" rx="1.6" /></>);
export const IconUndo = svg(<><path d="M4 9h9a5.5 5.5 0 0 1 0 11H8" /><path d="M7.5 5.5L4 9l3.5 3.5" /></>);
export const IconArrow = svg(<path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />);
export const IconMonitor = svg(<><rect x="3.5" y="5" width="17" height="11" rx="2" /><path d="M9 19.5h6M12 16v3.5" /></>);
export const IconFit = svg(<><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></>);
export const IconDots = svg(<><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>);
export const IconPaperclip = svg(<path d="M17 9l-6.5 6.5a3 3 0 0 1-4.2-4.2L13 4.5a4.3 4.3 0 0 1 6 6l-7 7" />);
export const IconClose = svg(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);
export const IconTarget = svg(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></>);

export const ROLE_ICON: Record<Role, (p: P) => React.ReactElement> = {
  pm: IconPlan, ref: IconImage, lead: IconStar, visual: IconPen, impl: IconCode, review: IconShield, exec: IconLayers,
};
