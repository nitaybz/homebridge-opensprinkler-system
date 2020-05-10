This is based off of the [homebridge-opensprinkler](http://github.com/timcharper/homebridge-opensprinkler) plugin originally created by Tim Charper used under the ISC license.

# OpenSprinkler

"Hey Siri, turn off my sprinklers."

"Hey Siri, are the Back Patio sprinklers on?"

## Overview

Simple OpenSprinkler / Homebridge integration.

### What works:

- Read and set rain delay
- Automatically update changes in state
- Show sprinkler state: idle, scheduled, running
- Show remaining duration
- Turn off sprinklers
- Ad-hoc turn on a single valve at a time.
- Allow duration to be specified per-station when enabled

### What doesn't work:

- Starting multiple programs in sequence (turning on multiple stations causes them to run concurrently)
- Persisting Home-configured station-specific default durations after restart
- Does not support multiple OpenSprinkler systems

## Installation

You must have NodeJS `v10.17.0` or later. Check your node version:

```shell script
node --version
```

You need [Homebridge](https://github.com/nfarina/homebridge) installed and configured. This plugin was developed against Homebridge `1.0.0`.

```shell script
npm install -g homebridge
```

Install this plug-in:

```shell script
npm install -g homebridge-opensprinkler-system
```

Updating:

```shell script
npm update -g homebridge-opensprinkler-system
```

Add the section below to your homebridge `platforms` section.

## Configuration

- `host`: The IP or DNS name of the OpenSprinkler controller
- `password`: Either the md5 hash of the password, or the password in plain text. I.E. `{"md5": "a6d82bced638de3def1e9bbb4983225c"}` or `{"plain": "opendoor"}`
- `defaultDurationSecs`: The duration for which a station will be run when toggled on.
- `pollIntervalMs`: The interval at which homebridge-opensprinkler will poll for state changes in OpenSprinkler.

Sample configuration:

```json
{
  "platform": "OpenSprinkler",
  "host": "sprinkler.lan",
  "password": {"md5": "a6d82bced638de3def1e9bbb4983225c"},
  "defaultDurationSecs": 600,
  "pollIntervalMs": 5000
}
```

