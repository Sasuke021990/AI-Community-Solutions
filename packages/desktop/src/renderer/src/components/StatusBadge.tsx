interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}
