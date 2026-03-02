// Sprinkler System (Platform version)
const fetch = require("node-fetch");
const packageJson = require("../package.json");

const PLUGIN_NAME = "homebridge-irrigation-system-platform";
const PLATFORM_NAME = "IrrigationSystemDomi";

let Service, Characteristic;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, IrrigationPlatform);
};

class IrrigationPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.cachedAccessory = null;

    this.api.on("didFinishLaunching", () => {
      this.log.info("IrrigationSystemDomi didFinishLaunching");
      this.ensureAccessory();
    });
  }

  configureAccessory(accessory) {
    // Homebridge restores cached accessories here
    this.log.info("Restored accessory from cache:", accessory.displayName);
    this.cachedAccessory = accessory;
  }

  ensureAccessory() {
    const name = this.config.name || "Irrigation System";
    const uuid = this.api.hap.uuid.generate(`IrrigationSystemDomi:${name}`);

    let accessory = this.cachedAccessory;

    if (!accessory || accessory.UUID !== uuid) {
      // If name changed, old cached accessory UUID differs; remove old and create new
      if (accessory) {
        this.log.warn(
          "Accessory name/UUID changed; removing old cached accessory:",
          accessory.displayName
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.log.info("Registering new platform accessory:", name);
      accessory = new this.api.platformAccessory(name, uuid);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessory = accessory;
    } else {
      this.log.info("Using cached platform accessory:", accessory.displayName);
    }

    // Store config so you can read it from accessory.context if you ever want
    accessory.context.config = this.config;

    // Build / rebuild services
    this.handler = new IrrigationAccessory(this.log, this.config, accessory);
  }
}

class IrrigationAccessory {
  constructor(log, config, accessory) {
    this.log = log;
    this.config = config || {};
    this.accessory = accessory;

    // zones safety (IMPORTANT: no default zone anymore)
    const zones = Array.isArray(this.config.zones) ? this.config.zones : [];
    this.zones = zones;
    this.zoned = this.zones.length;

    this.accessoryValve = [];
    this.zoneDuration = [];
    this.zoneTimeEnd = [];
    this.timeOut = [];

    // ---- AccessoryInformation (reuse if exists)
    this.accessoryInformationService =
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);

    this.accessoryInformationService.setCharacteristic(Characteristic.Identify, true);
    this.accessoryInformationService.setCharacteristic(
      Characteristic.Manufacturer,
      "Domi"
    );
    this.accessoryInformationService.setCharacteristic(Characteristic.Model, "DIY");
    this.accessoryInformationService.setCharacteristic(
      Characteristic.Name,
      "homebridge-irrigation"
    );
    this.accessoryInformationService.setCharacteristic(
      Characteristic.SerialNumber,
      "IRRIGATION-DOMI"
    );
    this.accessoryInformationService.setCharacteristic(
      Characteristic.FirmwareRevision,
      packageJson.version
    );

    // ---- Main IrrigationSystem service (reuse if exists)
    this.service =
      this.accessory.getService(Service.IrrigationSystem) ||
      this.accessory.addService(
        Service.IrrigationSystem,
        this.config.name || "Irrigation System"
      );

    this.service
      .setCharacteristic(
        Characteristic.ProgramMode,
        Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED
      )
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
      .setCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
      .setCharacteristic(Characteristic.RemainingDuration, 0)
      .setCharacteristic(Characteristic.WaterLevel, 100);

    // IMPORTANT:
    // When zone count changes, the Valve services need to be removed/added cleanly.
    // Valves are "linked" to the IrrigationSystem service; we must unlink before removing.
    this.cleanupOldValves();

    // If no zones are configured: do not create valves, do not poll, and stop here.
    if (this.zoned < 1) {
      this.log.warn(
        "No zones configured (config.zones is empty). Skipping Valve services and skipping webhook polling."
      );

      // Ensure any previous polling timer is stopped (in case of hot-reload / rebuild)
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
      return;
    }

    // Build / reuse valves
    for (let zone = 1; zone <= this.zoned; zone++) {
      const zconf = this.zones[zone - 1];
      const zname = zconf.zonename || `Zone ${zone}`;
      const subtype = String(zone);

      this.zoneDuration[zone] = Number(zconf.setDuration || 20) * 60; // seconds
      this.zoneTimeEnd[zone] = 0;

      // Reuse existing Valve service by subtype to keep stable UUIDs
      this.accessoryValve[zone] =
        this.accessory.getServiceById(Service.Valve, subtype) ||
        this.accessory.addService(Service.Valve, zname, subtype);

      // Update display name (for reused service)
      try {
        this.accessoryValve[zone].setCharacteristic(Characteristic.Name, zname);
      } catch (e) {
        // ignore
      }

      this.accessoryValve[zone]
        .setCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE)
        .setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE)
        .setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION)
        .setCharacteristic(Characteristic.SetDuration, this.zoneDuration[zone])
        .setCharacteristic(Characteristic.RemainingDuration, 0)
        .setCharacteristic(Characteristic.ServiceLabelIndex, zone)
        .setCharacteristic(Characteristic.ConfiguredName, `Zone ${zone} ${zname}`)
        .setCharacteristic(
          Characteristic.IsConfigured,
          Characteristic.IsConfigured.CONFIGURED
        );

      this.accessoryValve[zone]
        .getCharacteristic(Characteristic.Active)
        .onGet(this.getOnHandlerValve.bind(this, zone))
        .onSet(this.setOnHandlerValve.bind(this, zone));

      this.accessoryValve[zone]
        .getCharacteristic(Characteristic.InUse)
        .onGet(this.getOnHandlerValve.bind(this, zone));

      this.accessoryValve[zone]
        .getCharacteristic(Characteristic.SetDuration)
        .setProps({ minValue: 0, maxValue: 7200 })
        .onSet(this.setOnHandlerZoneDuration.bind(this, zone));

      this.accessoryValve[zone]
        .getCharacteristic(Characteristic.RemainingDuration)
        .setProps({ minValue: 0, maxValue: 7200 })
        .onGet(this.getOnHandlerZoneDuration.bind(this, zone));

      // Link valve to irrigation system (avoid duplicate linking)
      try {
        this.service.addLinkedService(this.accessoryValve[zone]);
      } catch (e) {
        // ignore (already linked)
      }
    }

    // Polling Blynk status (ONLY when zones exist)
	this.sendValue();
    this.startPolling();
  }

  cleanupOldValves() {
    // Remove Valve services that are no longer needed (zone count decreased),
    // and ensure we unlink before removing.
    const services = (this.accessory.services || []).slice();

    for (const s of services) {
      if (s.UUID !== Service.Valve.UUID) continue;

      // subtype is set to String(zone) in this plugin
      const idx = Number(s.subtype);

      // If subtype is invalid, or outside current zone range, remove it
      if (!Number.isFinite(idx) || idx < 1 || idx > this.zoned) {
        try {
          this.service.removeLinkedService(s);
        } catch (e) {
          // ignore
        }
        try {
          this.accessory.removeService(s);
        } catch (e) {
          // ignore
        }
      }
    }
  }

  startPolling() {
    // If no zones, do not start polling (and stop any existing timer)
    if (this.zoned < 1) {
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
      return;
    }

    // Clear previous interval if hot reload / cached rebuild happens
    if (this._pollTimer) clearInterval(this._pollTimer);

    this._pollTimer = setInterval(() => {
      fetch(
        `http://${this.config.ip}:8080/${this.config.token}/get/V${this.config.pin}`
      )
        .then((response) => response.text())
        .then((data) => {
          data = data.slice(2, data.length - 2);
          const result = JSON.parse(data);

          for (let zone = 1; zone <= this.zoned; zone++) {
            const inUseChar = this.accessoryValve[zone].getCharacteristic(
              Characteristic.InUse
            );
            const currentlyInUse = inUseChar.value == 1;

            const remoteInUse = !!(result[zone] && Number(result[zone].InUse) === 1);

            if (!currentlyInUse && remoteInUse) {
              this.setInUseOn(zone);
            } else if (currentlyInUse && !remoteInUse) {
              this.setInUseOff(zone);
            }
          }
        })
        .catch((error) => {
          this.log.error("Request to webhook failed.");
          this.log.error(error);
        });
    }, 1000);
  }

  setOnHandlerZoneDuration(zone, value) {
    this.zoneDuration[zone] = Number(value || 0);
  }

  getOnHandlerZoneDuration(zone) {
    // RemainingDuration is in seconds
    let retTime =
      this.zoneDuration[zone] - (Date.now() - this.zoneTimeEnd[zone]) / 1000;
    if (retTime < 0) retTime = 0;
    return retTime;
  }

  getOnHandlerValve(zone) {
    return this.accessoryValve[zone].getCharacteristic(Characteristic.InUse).value;
  }

  setInUseOn(zone) {
    this.zoneTimeEnd[zone] = Date.now();

    this.accessoryValve[zone].updateCharacteristic(
      Characteristic.RemainingDuration,
      this.zoneDuration[zone]
    );
    this.accessoryValve[zone].updateCharacteristic(
      Characteristic.InUse,
      Characteristic.InUse.IN_USE
    );
    this.accessoryValve[zone].updateCharacteristic(
      Characteristic.Active,
      Characteristic.Active.ACTIVE
    );

    if (this.timeOut[zone]) clearTimeout(this.timeOut[zone]);

    this.timeOut[zone] = setTimeout(() => {
      this.setInUseOff(zone);
      this.sendValue();
    }, this.zoneDuration[zone] * 1000);
  }

  setInUseOff(zone) {
    if (this.timeOut[zone]) clearTimeout(this.timeOut[zone]);

    this.accessoryValve[zone].updateCharacteristic(
      Characteristic.InUse,
      Characteristic.InUse.NOT_IN_USE
    );
    this.accessoryValve[zone].updateCharacteristic(
      Characteristic.Active,
      Characteristic.Active.INACTIVE
    );
    this.accessoryValve[zone].updateCharacteristic(
      Characteristic.RemainingDuration,
      0
    );
  }

  setOnHandlerValve(zone, value) {
    if (value == true) {
      this.setInUseOn(zone);
    } else {
      this.setInUseOff(zone);
    }
    this.sendValue();
  }

  sendValue() {
    // If no zones, nothing to send
    if (this.zoned < 1) return;

    let dataValue = `{"1":{"InUse":"${this.accessoryValve[1].getCharacteristic(
      Characteristic.InUse
    ).value}"}`;

    for (let zone = 2; zone <= this.zoned; zone++) {
      dataValue += `,"${zone}":{"InUse":"${this.accessoryValve[zone].getCharacteristic(
        Characteristic.InUse
      ).value}"}`;
    }
    dataValue += `}`;

    fetch(
      `http://${this.config.ip}:8080/${this.config.token}/update/V${this.config.pin}?value=${encodeURIComponent(
        dataValue
      )}`
    )
      .then((response) => {
        if (response.ok === false) throw new Error(`Status code (${response.status})`);
      })
      .catch((error) => {
        this.log.error("Request to webhook failed.");
        this.log.error(error);
      });
  }
}
