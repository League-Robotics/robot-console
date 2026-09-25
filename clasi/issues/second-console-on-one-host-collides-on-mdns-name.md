---
status: pending
---

# A second console on the same machine collides on its mDNS service name

Seen on the sprint 024 bench (2026-09-25). With one console already
running on port 4799, starting a second one on port 4797 on the same
machine logged:

```
Error: Service name is already in use on the network
    at …/bonjour-service/dist/lib/registry.js:32:37
```

The second console kept serving, but its LAN advertisement (added in the
sprint 021 LAN discovery) failed. Two consoles on one machine is a stated
goal (mbtools `docs/design/robot-console-integration.md` §6 item 7:
"configurable port so two consoles can run on one machine").

## Fix

Make the advertised instance name unique per console, for example by
appending the port or a configurable instance name, or retry with a suffix
on a name conflict. Handle the error so it is logged once instead of
thrown.
