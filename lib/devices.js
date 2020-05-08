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
      this.setDuration = defaultDurationSecs
      this.sid = sid;
      this.name = name;
      this.currentlyActive = false;
      this.currentlyInUse = false;
      this.pollUpdateTracker = new PollUpdateTracker("SprinklerStation " + name)
    }

    updateState(currentTime, programId, remaining, startedAt, inUse) {
      this.pollUpdateTracker.nudge()
      this.currentlyInUse = inUse != 0 // inUse means it is spraying water
      this.currentlyActive = programId != 0 // active means it is associated with a program, but may not currently be active
      // log("inUse: " + this.currentlyInUse + " active: " + this.currentlyActive);

      if (this.valveService) {
        this.valveService.getCharacteristic(Characteristic.Active)
			    .updateValue(this.currentlyActive);

		    this.valveService.getCharacteristic(Characteristic.InUse)
			    .updateValue(this.currentlyInUse);

        this.valveService.getCharacteristic(Characteristic.RemainingDuration)
				  .updateValue(remaining);
      }
    }

    getServices() {
      let informationService = new Service.AccessoryInformation();
      informationService
        .setCharacteristic(Characteristic.Manufacturer, "OpenSprinkler")
        .setCharacteristic(Characteristic.Model, "OpenSprinkler")
        .setCharacteristic(Characteristic.SerialNumber, "opensprinkler-" + this.sid);

      this.valveService = new Service.Valve(this.name);
      this.valveService.getCharacteristic(Characteristic.ValveType).updateValue(Characteristic.ValveType.IRRIGATION);

      this.valveService
        .getCharacteristic(Characteristic.Active)
        .on('get', syncGetter(this.getSprinklerActiveCharacteristic.bind(this)))
        .on('set', promiseSetter(this.setSprinklerActiveCharacteristic.bind(this)))

      this.valveService
        .getCharacteristic(Characteristic.InUse)
        .on('get', syncGetter(this.getSprinklerInUseCharacteristic.bind(this)))

      this.valveService.addCharacteristic(Characteristic.SetDuration)
          .on('get', syncGetter(() => this.setDuration))
          .on('set', (duration, next) => {
            this.setDuration = duration
            log.debug("SetDuration", duration)
            next()
          })

      this.valveService.addCharacteristic(Characteristic.RemainingDuration)

      this.informationService = informationService;
      return [informationService, this.valveService];
    }

    getSprinklerActiveCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      log("getSprinklerActiveCharacteristic returning " + this.currentlyActive)
      return this.currentlyActive
    }

    setSprinklerActiveCharacteristic(on) {
      log("setSprinklerActiveCharacteristic " + on)
      if (on)
        return openSprinklerApi.setValve(this.sid, true, this.setDuration)
      else
        return openSprinklerApi.setValve(this.sid, false, 0)
    }

    getSprinklerInUseCharacteristic() {
      this.pollUpdateTracker.assertRecent()
      log("getSprinklerInUseCharacteristic returning " + this.currentlyInUse)
      return this.currentlyInUse;
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
      this.sprinklers = []
      for (let i = 0; i < systemStatus.stations.snames.length; i++) {
        this.sprinklers.push(new SprinklerStation(systemStatus.stations.snames[i], i))
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

      // Update all the valves
      this.sprinklers.forEach((sprinkler) => {
        // tuple is [programId, remaining, startedAt]
        // non-zero programId means sprinkler is running
        const tuple = status.settings.ps[sprinkler.sid]
        const programId = tuple[0]
        const remaining = tuple[1]
        const startedAt = tuple[2]
        const inUse = status.status.sn[sprinkler.sid]

        totalRemainingTime += remaining
        systemActive = systemActive || (programId != 0)
        systemInUse = systemInUse || (inUse != 0)

        sprinkler.updateState(status.settings.devt,
            programId,
            remaining,
            startedAt,
            inUse);
      });

      //To determine program status, look at programs->nprogs
      let programsSet = status.programs.nprogs > 0

      this.pollUpdateTracker.nudge()
      this.active = systemActive ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE
      this.inUse = systemInUse ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE
      this.programMode = programsSet
      this.remainingDuration = totalRemainingTime

      if (this.irrigationSystemService) {
        this.irrigationSystemService.getCharacteristic(Characteristic.Active).updateValue(this.active)
        this.irrigationSystemService.getCharacteristic(Characteristic.InUse).updateValue(this.inUse)
        this.irrigationSystemService.getCharacteristic(Characteristic.ProgramMode).updateValue(this.programMode)
        this.irrigationSystemService.getCharacteristic(Characteristic.RemainingDuration).updateValue(this.remainingDuration)
      }
    }

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
        const standardName = 'S' + (sprinkler.sid + 1)
        let userGaveName = standardName != sprinkler.name;
        if (userGaveName) {
          sprinkler.valveService = new Service.Valve(sprinkler.name, sprinkler.name);
        } else {
          sprinkler.valveService = new Service.Valve("",sprinkler.name);
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
        sprinkler.valveService.addCharacteristic(Characteristic.ServiceLabelIndex).setValue(sprinkler.sid + 1)

        // Set if it's configured
        const isConfigured = userGaveName ? Characteristic.IsConfigured.CONFIGURED : Characteristic.IsConfigured.NOT_CONFIGURED
        sprinkler.valveService.addCharacteristic(Characteristic.IsConfigured).setValue(isConfigured)

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
    setSystemActiveCharacteristic() {
      //TODO: Implement
      log("Set sprinkler system to active")
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
