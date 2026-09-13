import { nameToValue } from "@robot-console/protocol";
import { describe, expect, it } from "vitest";
import { openStoreDb } from "../db.js";
import { Store } from "../index.js";
import { repairRadioLinkDeviceAssociation } from "./repairRadioLinkDeviceAssociation.js";

/** A fresh in-memory, fully-migrated store for one test. */
function freshStore(): Store {
  return new Store(openStoreDb({ filePath: ":memory:" }));
}

const TIGEZ_ID = nameToValue("tigez");
const GOPIV_ID = nameToValue("gopiv");

describe("repairRadioLinkDeviceAssociation (018-010)", () => {
  it("re-points the stakeholder's exact shape: radio-tigez-via-mbrelay-torture carrying gopiv's own device_id", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: GOPIV_ID, name: "gopiv", kind: "robot", at: 100 });
      store.upsertDevice({ id: TIGEZ_ID, name: "tigez", kind: "robot", at: 100 });
      // Seeded exactly as the live-evidenced bug: a link id naming
      // `tigez` carrying `gopiv`'s own device_id (bypassing `upsertLink`'s
      // own write-time guard by writing the raw row directly, mirroring
      // how an already-corrupted database looks by the time this repair
      // ever runs against it).
      store.upsertLink({ id: "radio-tigez-via-mbrelay-torture", transport: "radio", address: { relayLinkId: "mbrelay-torture", channel: 55, group: 114 }, at: 100 });
      store.setLinkDeviceId("radio-tigez-via-mbrelay-torture", GOPIV_ID);

      repairRadioLinkDeviceAssociation(store);

      const link = store.snapshotRows().links.find((l) => l.id === "radio-tigez-via-mbrelay-torture");
      expect(link?.device_id).toBe(TIGEZ_ID);
    } finally {
      store.close();
    }
  });

  it("drops the association (device_id -> NULL) when no device is named by the link id at all", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: GOPIV_ID, name: "gopiv", kind: "robot", at: 100 });
      store.upsertLink({ id: "radio-tigez-via-mbrelay-torture", transport: "radio", address: { relayLinkId: "mbrelay-torture", channel: 55, group: 114 }, at: 100 });
      store.setLinkDeviceId("radio-tigez-via-mbrelay-torture", GOPIV_ID);

      repairRadioLinkDeviceAssociation(store);

      const link = store.snapshotRows().links.find((l) => l.id === "radio-tigez-via-mbrelay-torture");
      expect(link?.device_id).toBeNull();
    } finally {
      store.close();
    }
  });

  it("leaves an already-correct radio link association alone", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: TIGEZ_ID, name: "tigez", kind: "robot", at: 100 });
      store.upsertLink({ id: "radio-tigez-via-mbrelay-torture", transport: "radio", address: { relayLinkId: "mbrelay-torture", channel: 55, group: 114 }, deviceId: TIGEZ_ID, at: 100 });

      repairRadioLinkDeviceAssociation(store);

      const link = store.snapshotRows().links.find((l) => l.id === "radio-tigez-via-mbrelay-torture");
      expect(link?.device_id).toBe(TIGEZ_ID);
    } finally {
      store.close();
    }
  });

  it("never touches a relay's own connectivity link (no -via- segment) even if it happens to share a device's name", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: -1, name: "torture", kind: "relay", at: 100 });
      store.upsertLink({ id: "usb-torture-serial", transport: "usb", address: { path: "/dev/cu.usbmodem-torture" }, deviceId: -1, at: 100 });

      repairRadioLinkDeviceAssociation(store);

      const link = store.snapshotRows().links.find((l) => l.id === "usb-torture-serial");
      expect(link?.device_id).toBe(-1);
    } finally {
      store.close();
    }
  });

  it("is idempotent -- a second run on an already-repaired store makes no further changes", () => {
    const store = freshStore();
    try {
      store.upsertDevice({ id: GOPIV_ID, name: "gopiv", kind: "robot", at: 100 });
      store.upsertDevice({ id: TIGEZ_ID, name: "tigez", kind: "robot", at: 100 });
      store.upsertLink({ id: "radio-tigez-via-mbrelay-torture", transport: "radio", address: { relayLinkId: "mbrelay-torture", channel: 55, group: 114 }, at: 100 });
      store.setLinkDeviceId("radio-tigez-via-mbrelay-torture", GOPIV_ID);

      repairRadioLinkDeviceAssociation(store);
      expect(() => repairRadioLinkDeviceAssociation(store)).not.toThrow();

      const link = store.snapshotRows().links.find((l) => l.id === "radio-tigez-via-mbrelay-torture");
      expect(link?.device_id).toBe(TIGEZ_ID);
    } finally {
      store.close();
    }
  });
});
