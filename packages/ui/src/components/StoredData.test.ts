import { describe, expect, it } from "vitest";
import { deriveStoredData } from "./StoredData";

type Entry = { direction: "tx" | "rx"; line: string };
const tx = (line: string): Entry => ({ direction: "tx", line });
const rx = (line: string): Entry => ({ direction: "rx", line });

const VALUES =
  '{"ev":"calstore.values","wheel":0.7853,"tw":11.3,"slip":1.177,"has_wheel":1,"has_turn":1,"live_tw":11.3,"live_slip":1.177,"scale_l":1,"scale_r":0.98,"port_l":1,"port_r":2}';
const RUNS = '{"ev":"calstore.runs","wheel_runs":1,"turn_runs":1}';

describe("deriveStoredData", () => {
  it("is waiting on both until the robot answers", () => {
    const data = deriveStoredData([tx("RUN calshow #4"), tx("WIFICRED #5")]);
    expect(data.calibrationAnswer).toBe("waiting");
    expect(data.wifiAnswer).toBe("waiting");
    expect(data.wifi).toEqual([]);
  });

  it("reads the calibration store and every stored network, keeping spaces in a network name", () => {
    const data = deriveStoredData([
      tx("RUN calshow #4"),
      tx("WIFICRED #5"),
      rx("ack 4 0 none"),
      rx(VALUES),
      rx(RUNS),
      rx("wificred 0 1 Robot_Garage"),
      rx("wificred 3 0 Busboom Mesh"),
      rx("ack 5 0 none"),
    ]);
    expect(data.calibrationAnswer).toBe("answered");
    expect(data.calibration.values?.wheelCalib).toBe(0.7853);
    expect(data.calibration.values?.motorPortRight).toBe(2);
    expect(data.calibration.runs?.wheelRuns).toBe(1);
    expect(data.wifiAnswer).toBe("answered");
    expect(data.wifi).toEqual([
      { slot: 0, hasPassword: true, ssid: "Robot_Garage" },
      { slot: 3, hasPassword: false, ssid: "Busboom Mesh" },
    ]);
  });

  it("an acknowledged WIFICRED with no network lines means nothing is stored", () => {
    const data = deriveStoredData([tx("WIFICRED #5"), rx("ack 5 0 none")]);
    expect(data.wifiAnswer).toBe("answered");
    expect(data.wifi).toEqual([]);
  });

  it("a nack or an err for the command's own id is a refusal; another id's is not", () => {
    expect(deriveStoredData([tx("RUN calshow #4"), rx("ack 4 0 none"), rx("err 3 #4")]).calibrationAnswer).toBe("refused");
    expect(deriveStoredData([tx("WIFICRED #5"), rx("nack 5 0 none")]).wifiAnswer).toBe("refused");
    expect(deriveStoredData([tx("WIFICRED #5"), rx("nack 9 0 none"), rx("err 3 #9")]).wifiAnswer).toBe("waiting");
  });
});
