---
status: done
sprint: '027'
tickets:
- 027-007
---

# The Set Wi-Fi dialog's Show/Hide button has nothing to show when a password is already saved

Stakeholder report: "the password hide and show button doesn't hide or show
anything."

The toggle itself works (verified in Chromium on the live dialog: the input
flips between `text` and `password`). But when the host already has a
password saved for the network, `WifiCredentialsDialog` leaves the field
**empty** with the placeholder "saved — leave blank to keep". It asks for
credentials without `reveal: true`, so there is no text for Show/Hide to act
on, and the user cannot see which password will be written to the robot.

`ConfigurationPage`'s Wi-Fi tab already asks with `reveal: true` and shows
the password (stakeholder direction: everyone in the room knows it).

Wanted: the dialog prefills the saved password the same way, so Show/Hide
works on it and the user can check it before writing it to the robot.
Files: `packages/ui/src/components/WifiCredentialsDialog.tsx`,
`WifiCredentialsForm.tsx`.
