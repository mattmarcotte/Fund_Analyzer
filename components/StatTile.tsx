/**
 * A single headline figure. Values use proportional figures (per the type spec);
 * only columns that must align vertically get tabular-nums.
 */
export function StatTile({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <div className="card px-4 py-3">
      <p
        className="text-[11px] uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </p>
      <p
        className="mt-1 text-2xl font-semibold leading-tight"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </p>
      {sublabel && (
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          {sublabel}
        </p>
      )}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h2>
          {subtitle && (
            <p
              className="mt-0.5 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
