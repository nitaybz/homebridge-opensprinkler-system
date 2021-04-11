function DevicesModule(config, log, openSprinklerApi, Service, Characteristic) {
  let defaultDurationSecs = config.defaultDurationSecs
  let pollTimeoutThresholdMs = config.pollIntervalMs * 3

  function syncGetter(fn) {
    return (next) => {
      try {
        next(null, fn())
      }
      catch (error) {
        log("error ", error)
        next(error)
      }
    }
  }

  function promiseSetter(fn) {
    return (value, next) => {
      fn(value).then(
        (result) => next(),
        (failure) => {
          log("failure " + failure)
          next(failure)
        }
      )
    }
  }

  /** Tracks poll updates; if no update after threshold, throw errors */
  class PollUpdateTracker {
    constructor(name) {
      this.name = name
      this.nudge()
    }
    nudge() {
      this.lastHeard = Date.now()
    }
    assertRecent() {
      let durationSinceLastHeardMs = Date.now() - this.lastHeard
      if (durationSinceLastHeardMs > pollTimeoutThresholdMs)
        throw("Haven't heard an update from " + this.name + " for the past " + durationSinceLastHeardMs + " ms")
    }
  }

  class RainDelay {
    constructor(rainDelayHoursSetting) {
      this.rainDelayHoursSetting = rainDelayHoursSetting;
      this.name = "Rain Delay";
      this.currentState = false;
      this.pollUpdateTracker = new PollUpdateTracker("RainDelay")
    }

    updateState(rd, rainDelayHoursSetting) {
      this.pollUpdateTracker.nudge()
      this.rainDelayHoursSetting = rainDelayHoursSetting
      // log("rain delay = " + rd);
      this.currentState = rd != 0;

      if (this.switchService) {
        this.switchService.getCharacteristic(Characteristic.On).
          updateValue(this.currentState);
      }
    }

    // noinspection JSUnusedGlobalSymbols
    getServices() {
      let informationService = new Service.AccessoryInformation();
      informationService
        .setCharacteristic(Characteristic.Manufacturer, "OpenSprinkler")
        .setCharacteristic(Characteristic.Model, "OpenSprinkler")
        .setCharacteristic(Characteristic.SerialNumber, "opensprinkler-raindelay");

      this.switchService = new Service.Switch(this.name);

      this.switchService
        .getCharacteristic(Characteristic.On)
        .on('get', syncGetter(this.getSwitchOnCharacteristic.bind(this)))
        .on('set', promiseSetter(this.setSwitchOnCharacteristic.bind(this)));

      this.informationService = informationService;
      return [informationService, this.switchService];
    }

    getSwitchOnCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      return this.currentState;
    }

    setSwitchOnCharacteristic(on) {
      log("setSprinklerOnCharacteristic " + on)
      if (on)
        return openSprinklerApi.setRainDelay(this.rainDelayHoursSetting)
      else
        return openSprinklerApi.setRainDelay(0)
    }
  }

  class SprinklerStation {
    constructor (name, sid) {
      /**
       * @type {number}
       */
      this.setDuration = defaultDurationSecs

      /**
       * The station id on the OS controller for the sprinkler.
       * Station ids start from one on open sprinkler, but all information returned in arrays from api calls start at 0.
       * @type {number}
       */
      this.sid = sid;
      /**
       * @type {string}
       */
      this.name = name;
      this.currentlyActive = false;
      this.currentlyInUse = false;
      this.isDisabled = false;
      this.pollUpdateTracker = new PollUpdateTracker("SprinklerStation " + name)
      this.disabledStations = 0
    }

    updateState(currentTime, programId, remaining, startedAt, inUse, disabledStations) {
      this.pollUpdateTracker.nudge()
      this.currentlyInUse = inUse != 0 // inUse means it is spraying water
      this.currentlyActive = programId != 0 // active means it is associated with a program, but may not currently be active
      // log("inUse: " + this.currentlyInUse + " active: " + this.currentlyActive);

      this.disabledStations = disabledStations
      if (this.valveService) {
        this.valveService.getCharacteristic(Characteristic.Active)
			    .updateValue(this.currentlyActive);

		    this.valveService.getCharacteristic(Characteristic.InUse)
			    .updateValue(this.currentlyInUse);

        this.valveService.getCharacteristic(Characteristic.RemainingDuration)
          .updateValue(remaining);
          
      }
    }

    getSprinklerActiveCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      log("getSprinklerActiveCharacteristic returning " + this.currentlyActive)
      return this.currentlyActive
    }

    setSprinklerActiveCharacteristic(on) {
      log("setSprinklerActiveCharacteristic " + on)
      if (on)
        return openSprinklerApi.setValve(this.sid - 1, true, this.setDuration)
      else
        return openSprinklerApi.setValve(this.sid - 1, false, 0)
    }

    getSprinklerInUseCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      log("getSprinklerInUseCharacteristic returning " + this.currentlyInUse)
      return this.currentlyInUse;
    }

    getSprinklerConfiguredCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      // log(this.sid +  "getSprinklerConfiguredCharacteristic returning is Disaled?" + this.isDisabled)
      return (!this.isDisabled ? Characteristic.IsConfigured.CONFIGURED : Characteristic.IsConfigured.NOT_CONFIGURED)
    }

    setSprinklerConfiguredCharacteristic(status) {
      // log("setSprinklerConfiguredCharacteristic " + status)
      if (status)
          return openSprinklerApi.setDisabledStations(this.sid - 1, true, this.disabledStations)
        else
          return openSprinklerApi.setDisabledStations(this.sid - 1, false, this.disabledStations)
      }
  }

  /**
   * Represents the main open sprinkler control system which will be exposed as an accessory with the IrrigationSystem
   * service.
   */
  class OSSystem {
    constructor(systemStatus) {
      this.name = "OpenSprinkler System"
      this.active = Characteristic.Active.INACTIVE
      this.inUse = false
      this.programMode = Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED
      this.remainingDuration = 0
      this.pollUpdateTracker = new PollUpdateTracker("SprinklerSystem")

      // Create all the sub-sprinklers
      this.masterStations = [systemStatus.options.mas, systemStatus.options.mas2]
      this.disabledStations = systemStatus.stations.stn_dis[0]
      this.sprinklers = []
      for (let i = 0; i < systemStatus.stations.snames.length; i++) {
        this.sprinklers.push(new SprinklerStation(systemStatus.stations.snames[i], i + 1))
      }
    }

    /**
     * Updates this accessory's state from the new status from the OS controller
     * @param status {json}
     */
    updateState(status) {
      let totalRemainingTime = 0
      // Will be active if any of the sprinklers are active
      let systemActive = false
      let systemInUse = false
      let manualOverride = false

      // Update all the valves
      this.sprinklers.forEach((sprinkler) => {
        // tuple is [programId, remaining, startedAt]
        // non-zero programId means sprinkler is running
        const tuple = status.settings.ps[sprinkler.sid - 1]
        const programId = tuple[0]
        const remaining = tuple[1]
        const startedAt = tuple[2]
        const inUse = status.status.sn[sprinkler.sid - 1]

        this.disabledStations = status.stations.stn_dis[0]

        // Check if disabled

        sprinkler.disabledBinary = this.disabledStations.toString(2).split('').reverse()
        sprinkler.isDisabled = sprinkler.disabledBinary[sprinkler.sid - 1] === '1'

        // log('DISABLED DATA (update) -------->' + sprinkler.disabledBinary + ' ' + reverseIndex  + ' ' + sprinkler.isDisabled)

        totalRemainingTime += remaining
        systemActive = systemActive || (programId != 0)
        systemInUse = systemInUse || (inUse != 0)
        // Program id of 99 is manual override so note that there is a manual override in effect
        manualOverride = manualOverride || (programId == '99')

        sprinkler.updateState(status.settings.devt,
            programId,
            remaining,
            startedAt,
            inUse,
            this.disabledStations);
      });

      //To determine program status, look at programs->nprogs
      let programsSet = status.programs.nprogs > 0

      if (programsSet && manualOverride) {
        this.programMode = Characteristic.ProgramMode.PROGRAM_SCHEDULED_MANUAL_MODE_
      } else if (programsSet && !manualOverride) {
        this.programMode = Characteristic.ProgramMode.PROGRAM_SCHEDULED
      } else {
        this.programMode = Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED
      }

      this.pollUpdateTracker.nudge()
      this.active = systemActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE
      this.inUse = systemInUse ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE
      this.remainingDuration = totalRemainingTime

      if (this.irrigationSystemService) {
        this.irrigationSystemService.getCharacteristic(Characteristic.Active).updateValue(this.active)
        this.irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(this.inUse)
        this.irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(this.programMode)
        this.irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).updateValue(this.remainingDuration)
      }
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     * Primary service is IrrigationSystem service, must expose:
     * - Active: If the system is enabled
     * - InUse: If any of it's linked valves are InUse
     * - ProgramMode: No programs, programs scheduled, or programs scheduled but currently overridden
     * Can also expose: RemainingDuration, Name, and SystemFault
     */
    getServices() {
      let services = []
      this.informationService = new Service.AccessoryInformation();
      this.informationService
          .setCharacteristic(Characteristic.Manufacturer, "OpenSprinkler")
          .setCharacteristic(Characteristic.Model, "OpenSprinkler")
          .setCharacteristic(Characteristic.SerialNumber, "opensprinkler-system");
      services.push(this.informationService)

      // Add the irrigation system service
      this.irrigationSystemService = new Service.IrrigationSystem(this.name);
      this.irrigationSystemService.getCharacteristic(Characteristic.Active)
          .on("get", syncGetter(this.getSystemActiveCharacteristic.bind(this)))
          .on('set', promiseSetter(this.setSystemActiveCharacteristic.bind(this)))

      this.irrigationSystemService.getCharacteristic(Characteristic.InUse)
          .on('get', syncGetter(this.getSystemInUseCharacteristic.bind(this)))

      this.irrigationSystemService.getCharacteristic(Characteristic.ProgramMode)
          .on('get', syncGetter(this.getSystemProgramModeCharacteristic.bind(this)))

      this.irrigationSystemService.addCharacteristic(Characteristic.RemainingDuration)
          .on('get', syncGetter(this.getSystemRemainingDurationCharacteristic.bind(this)))

      this.irrigationSystemService.setPrimaryService(true)

      services.push(this.irrigationSystemService)

      // Add the service label service
      this.serviceLabelService = new Service.ServiceLabel()
      this.serviceLabelService.getCharacteristic(Characteristic.ServiceLabelNamespace).setValue(Characteristic.ServiceLabelNamespace.DOTS)

      // Add all of the valve services
      this.sprinklers.forEach(function (sprinkler) {
        sprinkler.valveService = new Service.Valve("", "zone-" + sprinkler.sid);
        // sprinkler.valveService.subtype = "zone-" + sprinkler.sid

        // Set the valve name
        const standardName = 'S' + ('0' + sprinkler.sid).slice(-2);
        let userGaveName = standardName != sprinkler.name;
        // log("Valve name:", sprinkler.name, userGaveName)
        if (userGaveName) {
          sprinkler.valveService.getCharacteristic(Characteristic.Name).setValue(sprinkler.name)
          // sprinkler.valveService.addCharacteristic(Characteristic.ConfiguredName).setValue(sprinkler.name)
        }

        sprinkler.valveService.getCharacteristic(Characteristic.ValveType).updateValue(Characteristic.ValveType.IRRIGATION);

        sprinkler.valveService
            .getCharacteristic(Characteristic.Active)
            .on('get', syncGetter(sprinkler.getSprinklerActiveCharacteristic.bind(sprinkler)))
            .on('set', promiseSetter(sprinkler.setSprinklerActiveCharacteristic.bind(sprinkler)))

        sprinkler.valveService
            .getCharacteristic(Characteristic.InUse)
            .on('get', syncGetter(sprinkler.getSprinklerInUseCharacteristic.bind(sprinkler)))

        sprinkler.valveService.addCharacteristic(Characteristic.SetDuration)
            .on('get', syncGetter(() => sprinkler.setDuration))
            .on('set', (duration, next) => {
              sprinkler.setDuration = duration
              log.debug("SetDuration", duration)
              next()
            })

        sprinkler.valveService.addCharacteristic(Characteristic.RemainingDuration)

        // Set its service label index
        sprinkler.valveService.addCharacteristic(Characteristic.ServiceLabelIndex).setValue(sprinkler.sid)
        
        // Check if disabled
        sprinkler.disabledBinary = this.disabledStations.toString(2).split('').reverse()
        sprinkler.isDisabled = sprinkler.disabledBinary[sprinkler.sid - 1] === '1'

        // log('DISABLED length + sid -------->' + this.sprinklers.length + ' ' + sprinkler.sid)
        // log('DISABLED DATA -------->' + sprinkler.disabledBinary + ' ' + (sprinkler.sid - 1)  + ' ' + sprinkler.isDisabled)

        // Set if it's not disabled
        // const isConfigured = !sprinkler.isDisabled ? Characteristic.IsConfigured.CONFIGURED : Characteristic.IsConfigured.NOT_CONFIGURED
        sprinkler.valveService.getCharacteristic(Characteristic.IsConfigured)
          .on('get', syncGetter(sprinkler.getSprinklerConfiguredCharacteristic.bind(sprinkler)))
          .on('set', promiseSetter(sprinkler.setSprinklerConfiguredCharacteristic.bind(sprinkler)))
          // .setValue(isConfigured)

        // Link this service
        this.irrigationSystemService.addLinkedService(sprinkler.valveService)
        this.serviceLabelService.addLinkedService(sprinkler.valveService)

        services.push(sprinkler.valveService)
      }.bind(this))

      return services
    }

    /**
     * Should be active if any of the stations are active
     * @returns {boolean}
     */
    getSystemActiveCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      return this.active
    }

    /**
     * If set to false then stop all stations (cv command)
     */
    setSystemActiveCharacteristic(value) {
      log("Set sprinkler system active to", value)
      if (!value) {
        // Stop all stations
        return openSprinklerApi.stopAllStations()
      } else {
        //If the system is being set to active then just do nothing, return a promise that just returns
        return new Promise((resolve) =>
            resolve(value)
        )
      }
    }

    /**
     * Returns if any of the stations are in use
     * @returns {boolean}
     */
    getSystemInUseCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      return this.inUse
    }

    getSystemProgramModeCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      return this.programMode
    }

    /**
     * The sum of the remaining durations of all the stations
     * @returns {number}
     */
    getSystemRemainingDurationCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      return this.remainingDuration
    }
  }

  return {RainDelay, SprinklerStation, OSSystem}
}
module.exports = DevicesModule
