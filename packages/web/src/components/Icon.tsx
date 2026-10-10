/** Small inline SVG icon set (stroke icons, 24×24). */
const PATHS: Record<string, string> = {
  pen: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  notes: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  review: 'M4 6h16M4 12h10M4 18h7M16 16l2 2 4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  graph:
    'M6 6m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M18 7m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M12 18m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M8 7l8 0M7 8l4 8M17 9l-4 7',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  back: 'M15 18l-6-6 6-6',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  heading: 'M6 4v16M18 4v16M6 12h12',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  task: 'M4 4h6v6H4zM5.5 7l1.5 1.5L9 5.5M13 7h7M4 14h6v6H4zM13 17h7',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7',
  key: 'M15 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12.5 11.5L4 20M7 17l2 2M5 19l2 2',
  bot: 'M5 9h14v10H5zM12 5v4M9 13h.01M15 13h.01M9 16h6M12 3m-1 0a1 1 0 1 0 2 0 1 1 0 1 0-2 0',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  cloud: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1 0 8z',
  offline: 'M3 3l18 18M8.5 8.4A5 5 0 0 0 7 18h11M19 10a4 4 0 0 1 2 6.5M10.7 6.2A6 6 0 0 1 19 10',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  ask: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16h.01',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  menu: 'M4 6h16M4 12h16M4 18h16',
  sync: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  kanban: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z',
  share: 'M12 3v12M8 7l4-4 4 4M5 13v7h14v-7',
};

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 20,
  className,
  title,
}: {
  name: IconName | string;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : 'icon'}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? PATHS['file']} />
    </svg>
  );
}
