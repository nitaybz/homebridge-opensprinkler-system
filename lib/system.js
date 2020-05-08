function SystemModule(config, log, openSprinklerApi, Devices) {
  let pollIntervalMs = config.pollIntervalMs
  function withTimeoutCancellation(promise, duration) {
    return new Promise((success, reject) => {
      let timer = setTimeout(() => {
        log("cancelling promise because it is too slow")
        reject("too slow")
      }, duration)
      promise.finally(() => clearTimeout(timer))
      promise.then(success,reject)
    })
  }

  class System {
    constructor(status) {
      let names = status.stations.snames
      log("Station names:")
      log(names)

      // Create the system accessory first
      this.irrigationSystem = new Devices.OSSystem(status)

      // this.valves = config.enabledStationIds.map(function (valveIndex) {
      //   let sprinkler = new Devices.SprinklerStation(names[valveIndex], valveIndex)
      //   // sprinkler.updateState(status.settings.ps[valveIndex]);
      //   return(sprinkler)
      // });
      this.rainDelay = new Devices.RainDelay(status.settings.wto.d)

      this.updateAccessoriesFromStatus(status)

      this.poll();
    }

    getAccessories() {
      return [this.irrigationSystem, this.rainDelay]
      // return this.valves.concat([this.irrigationSystem, this.rainDelay])
    }

    poll() {
      log.debug("polling...")
      let done = withTimeoutCancellation(openSprinklerApi.getStatus(), pollIntervalMs * 5)
      done.then(
        (json) => {
          this.updateAccessoriesFromStatus(json)
        },
        (err) => {
          log("error while polling:", err)
        }
      )

      done.finally(() => {
        log.debug("queueing up next poll...")
        setTimeout(() => this.poll(), pollIntervalMs)
      })
    }

    /**
     * Takes the new status object from OS and parses it to update all the accessories
     * @param status {json}
     */
    updateAccessoriesFromStatus(status) {
      if (status) {
        // Update the system status
        this.irrigationSystem.updateState(status)

        // Update the rain delay
        this.rainDelay.updateState(status.settings.rd, status.settings.wto.d);
      }
    }
  }

  System.connect = () =>
    openSprinklerApi.getStatus().then((status) => new System(status))

  return System
}

module.exports = SystemModule
