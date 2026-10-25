import { useEffect, useState } from "react";
import { Link, useLocation, useMatch } from "react-router";
import { useDeviceForLink, useDevices, useHostVersion, useUnassigned } from "../ws/WsProvider";
import { benchEntries, frontPageGroups, statusWord, type BenchEntry } from "../status";
import { Icon, type IconName } from "./Icon";

const BENCH_TICK_MS = 30_000;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function benchTitle(entry: BenchEntry): string {
  return entry.status === "absent"
    ? `${entry.name}: ${statusWord(entry.status)}, seen ${entry.note} ago`
    : `${entry.name}: ${statusWord(entry.status)} over ${entry.note}`;
}

interface BrowseItem {
  label: string;
  icon: IconName;
  hash: string;
  count: number;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const devices = useDevices();
  const unassigned = useUnassigned();
  const hostVersion = useHostVersion();
  const location = useLocation();
  const deviceMatch = useMatch("/d/:linkId");
  const currentLinkId = deviceMatch?.params.linkId;
  const currentDevice = useDeviceForLink(currentLinkId);
  const now = useNow(BENCH_TICK_MS);

  const bench = benchEntries(devices, unassigned, now);
  const groups = frontPageGroups(devices);
  const items: BrowseItem[] = [
    { label: "All robots", icon: "robot", hash: "", count: groups.robots.length },
    { label: "Radio bridges", icon: "bridge", hash: "#group-bridges", count: groups.bridges.length },
    { label: "Joysticks", icon: "joystick", hash: "#group-joysticks", count: groups.joysticks.length },
    { label: "Not seen recently", icon: "more", hash: "#group-not-seen", count: groups.notSeenRecently.length },
  ];
  const browse = items.filter((item) => item.hash === "" || item.count > 0);
  const onHome = location.pathname === "/";

  return (
    <nav className="lg-rail app-rail" aria-label="Console">
      <Link to="/" className="lg-rail__brand" onClick={onNavigate}>
        <span className="lg-rail__mark" aria-hidden="true" />
        <span>
          <b>The LEAGUE</b>
          <small>Robot Console</small>
        </span>
      </Link>

      <h2 className="lg-bench__h" id="bench-heading">
        <span>On the bench</span>
        <span className="lg-bench__count" data-testid="bench-count" aria-label={`${bench.length} devices`}>
          {bench.length}
        </span>
      </h2>
      <p className="lg-bench__sub">Connected now or seen in the last 10 min</p>
      {bench.length === 0 ? (
        <p className="lg-bench__empty lg-bench">Nothing yet. Plug a micro:bit into a USB port.</p>
      ) : (
        <ul className="lg-bench" aria-labelledby="bench-heading">
          {bench.map((entry) => {
            const current =
              (entry.deviceId !== undefined && entry.deviceId === currentDevice?.id) ||
              (entry.deviceId === undefined && entry.linkId !== undefined && entry.linkId === currentLinkId);
            return (
              <li key={entry.key}>
                <Link
                  className="lg-bench__row"
                  data-status={entry.status}
                  data-testid={`bench-row-${entry.key}`}
                  to={entry.linkId ? `/d/${entry.linkId}` : { pathname: "/", hash: `#${entry.key}` }}
                  aria-current={current ? "page" : undefined}
                  title={benchTitle(entry)}
                  onClick={onNavigate}
                >
                  <span className="lg-bench__ic">
                    <Icon name={entry.icon} size={16} />
                  </span>
                  <span className="lg-bench__name">{entry.name}</span>
                  <span className="lg-bench__note">{entry.note}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <div className="lg-nav">
        <h2 className="lg-nav__h">Browse</h2>
        {browse.map((item) => (
          <Link
            key={item.label}
            to={{ pathname: "/", hash: item.hash }}
            aria-current={onHome && location.hash === item.hash ? "page" : undefined}
            onClick={onNavigate}
          >
            <Icon name={item.icon} />
            {item.label}
            <span className="lg-nav__n">{item.count}</span>
          </Link>
        ))}
      </div>

      <div className="lg-rail__foot">
        <span>Host</span>
        {hostVersion && <code data-testid="host-version">{hostVersion}</code>}
      </div>
    </nav>
  );
}
