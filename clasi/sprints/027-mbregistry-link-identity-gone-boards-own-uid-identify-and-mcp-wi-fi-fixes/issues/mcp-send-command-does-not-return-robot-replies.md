---
status: in-progress
sprint: '027'
tickets:
- 027-006
---

# MCP `send_command` does not return the robot's reply lines

`mcp__robot-console__send_command` returns only `{ok, sent: "WIFICRED #1"}`.
The robot's reply (and any `DBG:` lines) never reaches the calling agent, so
an agent cannot read `WIFICRED`, `ID`, `DBG:wifi`, or any query verb's
answer through the console. `get_device_status` only exposes the parsed
`robotStatus` fields.

During the 2026-09-25 Wi-Fi investigation this forced agents to bypass the
console and open the serial port directly on the Pi.

Wanted: `send_command` returns the reply line(s) correlated to its request
(by `#seq`), plus any unsolicited lines seen within a short window, or a
separate read-recent-lines tool for a link.
