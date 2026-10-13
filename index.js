let Service, Characteristic, Accessory, UUID, HapStatusError, HAPStatus
const Leviton = require('./api.js')
const PLUGIN_NAME = 'homebridge-leviton'
const PLATFORM_NAME = 'LevitonDecoraSmart'
const levels = ['debug', 'info', 'warn', 'error']

class LevitonDecoraSmartPlatform {
  constructor(log, config, api) {
    this.config = config
    this.api = api
    this.accessories = []

    const noop = function () {}
    const logger = (level) => (msg) =>
      levels.indexOf((config && levels.includes(config.loglevel) && config.loglevel) || 'info') <= levels.indexOf(level)
        ? log(msg)
        : noop()

    // create a level method for each on this.log
    this.log = levels.reduce((a, l) => {
      a[l] = logger(l)
      return a
    }, {})

    if (config === null) {
      this.log.error(`No config for ${PLUGIN_NAME} defined.`)
      return
    }

    if (!config.email || !config.password) {
      this.log.error(`email and password for ${PLUGIN_NAME} are required in config.json`)
      return
    }

    // on launch, init api, iterate over new devices
    api.on('didFinishLaunching', async () => {
      this.log.debug('didFinishLaunching')
      const { devices, token } = await this.initialize(config)
      const excludedModels = (config.excludeModels || []).map((name) => name.toUpperCase())
      const excludedSerials = (config.excludeSerials || []).map((name) => name.toUpperCase())
      if (Array.isArray(devices) && devices.length > 0) {
        devices.forEach((device) => {
          if (!this.accessories.find((acc) => acc.context.device.serial === device.serial)) {
            if (!excludedModels.includes(device.model) && !excludedSerials.includes(device.serial)) {
              this.addAccessory(device, token)
            }
          }
        })
      } else {
        this.log.error('Unable to initialize: no devices found')
      }
    })
  }

  subscriptionCallback(payload) {
    const accessory = this.accessories.find((acc) => acc.context.device.id === payload.id)
    const { id, power, brightness } = payload

    this.log.debug(`Socket: ${accessory.displayName} (${id}): ${power} ${brightness ? `${brightness}%` : ''}`)

    if (!accessory) return

    const service =
      accessory.getService(Service.Fan) ||
      accessory.getService(Service.Switch) ||
      accessory.getService(Service.Outlet) ||
      accessory.getService(Service.Lightbulb)
    const isFan = !!accessory.getService(Service.Fan)

    if (payload.brightness)
      service
        .getCharacteristic(isFan ? Characteristic.RotationSpeed : Characteristic.Brightness)
        .updateValue(payload.brightness)
    service.getCharacteristic(Characteristic.On).updateValue(payload.power === 'ON')
  }

  // init function that sets up personID, accountID and residenceID to return token+devices
  async initialize() {
    this.log.debug('initialize')

    try {
      var login = await this.login()
      var { id: token, userId: personID } = login
      this.log.debug(`personID: ${personID}, hasToken: ${!!token}`)
    } catch (err) {
      this.log.error(`Failed to login to leviton: ${err.message}`)
    }
    try {
      const permissions = await Leviton.getPersonResidentialPermissions({
        personID,
        token,
      })
      var accountID = permissions[0].residentialAccountId
      this.log.debug(`accountID: ${accountID}`)
    } catch (err) {
      this.log.error(`Failed to get leviton accountID: ${err.message}`)
    }
    try {
      var { primaryResidenceId: residenceID, id: residenceObjectID } = await Leviton.getResidentialAccounts({
        accountID,
        token,
      })
      this.log.debug(`residenceID: ${residenceID}`)
    } catch (err) {
      this.log.error(`Failed to get leviton residenceID: ${err.message}`)
    }
    try {
      var devices = await Leviton.getResidenceIotSwitches({
        residenceID,
        token,
      })
      this.log.debug(`devices: ${JSON.stringify(devices)}`)
    } catch (err) {
      this.log.error(`Failed to get leviton devices: ${err.message}`)
    }

    try {
      if (!Array.isArray(devices) || devices.length < 1) {
        this.log.info('No devices found for primary residence id. Trying residence v2')

        const accountsV2Response = await Leviton.getResidentialAccountsV2({
          residenceObjectID,
          token,
        })

        if (accountsV2Response[0]) {
          residenceID = accountsV2Response[0].id
          devices = await Leviton.getResidenceIotSwitches({
            residenceID,
            token,
          })
        } else {
          throw new Error('No residenceIDs found')
        }

        if (!Array.isArray(devices) || devices.length < 1) {
          throw new Error(
            `No devices found for residenceID: ${residenceID} or residenceIDV2 method: ${residenceObjectID}`
          )
        } else {
          Leviton.subscribe(login, devices, this.subscriptionCallback.bind(this), this)
        }
      } else {
        Leviton.subscribe(login, devices, this.subscriptionCallback.bind(this), this)
      }
    } catch (err) {
      this.log.error(`Error subscribing devices to websocket updates: ${err.message}`)
    }

    return { devices, token }
  }

  // The token saved in cached accessories expires (Leviton ttl is 60 days) and was never refreshed,
  // so every request silently failed with 401 while HomeKit was told it succeeded.
  async login() {
    if (!this.loginInFlight) {
      this.loginInFlight = Leviton.postPersonLogin({ email: this.config['email'], password: this.config['password'] })
        .then((login) => {
          if (!login || !login.id) throw new Error('Leviton login failed')
          this.currentToken = login.id
          return login
        })
        .finally(() => {
          this.loginInFlight = null
        })
    }
    return this.loginInFlight
  }

  // run an API call with a live token, re-login once on 401, and throw on any API error
  async withAuth(fn) {
    if (!this.currentToken) await this.login()
    let res = await fn(this.currentToken)
    if (res && res.error && res.error.statusCode === 401) {
      this.log.info('Leviton token rejected (401), logging in again')
      await this.login()
      res = await fn(this.currentToken)
    }
    if (res && res.error) throw new Error(res.error.message || 'Leviton API error')
    return res
  }

  // Leviton's cloud reports `connected: false` for a device that is unplugged or offline.
  // Throwing a communication failure makes HomeKit show "No Response" for the accessory,
  // and it clears by itself the next time the device reports connected.
  assertConnected(status) {
    if (status && status.connected === false) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }

  // never send a command to an offline device, it could be queued and fire when it reconnects
  async putIfConnected(device, params) {
    const current = await this.withAuth((authToken) =>
      Leviton.getIotSwitch({
        switchID: device.id,
        token: authToken,
      })
    )
    this.assertConnected(current)
    return this.withAuth((authToken) =>
      Leviton.putIotSwitch({
        switchID: device.id,
        token: authToken,
        ...params,
      })
    )
  }

  handleError(label, err, callback) {
    if (err instanceof HapStatusError) this.log.debug(`${label}: device is offline`)
    else this.log.error(`${label} error: ${err.message}`)
    callback(err)
  }

  // switch power state getter, closure with service, device and token
  onGetPower(service, device, token) {
    return function (callback) {
      return this.withAuth((authToken) =>
        Leviton.getIotSwitch({
          switchID: device.id,
          token: authToken,
        })
      )
        .then((res) => {
          this.assertConnected(res)
          this.log.debug(`onGetPower: ${device.name} ${res.power}`)
          service.getCharacteristic(Characteristic.On).updateValue(res.power === 'ON')
          callback(null, res.power === 'ON')
        })
        .catch((err) => this.handleError('onGetPower', err, callback))
    }
  }

  // switch power state setter, closure with service, device and token
  onSetPower(service, device, token) {
    return function (value, callback) {
      return this.putIfConnected(device, { power: value ? 'ON' : 'OFF' })
        .then((res) => {
          this.log.info(`onSetPower: ${device.name} ${res.power}`)
          service.getCharacteristic(Characteristic.On).updateValue(res.power === 'ON')
          callback()
        })
        .catch((err) => this.handleError('onSetPower', err, callback))
    }
  }

  // switch brightness getter closure with service, device and token
  onGetBrightness(service, device, token) {
    return function (callback) {
      return this.withAuth((authToken) =>
        Leviton.getIotSwitch({
          switchID: device.id,
          token: authToken,
        })
      )
        .then((res) => {
          this.assertConnected(res)
          this.log.debug(`onGetBrightness: ${device.name} @ ${res.brightness}%`)
          service.getCharacteristic(Characteristic.Brightness).updateValue(res.brightness)
          callback(null, res.brightness)
        })
        .catch((err) => this.handleError('onGetBrightness', err, callback))
    }
  }

  // switch brightness setter closure with service, device and token
  onSetBrightness(service, device, token) {
    return function (brightness, callback) {
      return this.putIfConnected(device, { brightness })
        .then((res) => {
          this.log.info(`onSetBrightness: ${device.name} @ ${res.brightness}%`)
          service.getCharacteristic(Characteristic.Brightness).updateValue(res.brightness)
          callback()
        })
        .catch((err) => this.handleError('onSetBrightness', err, callback))
    }
  }

  // switch RotationSpeed getter closure with service, device and token
  onGetRotationSpeed(service, device, token) {
    return function (callback) {
      return this.withAuth((authToken) =>
        Leviton.getIotSwitch({
          switchID: device.id,
          token: authToken,
        })
      )
        .then((res) => {
          this.assertConnected(res)
          this.log.debug(`onGetRotationSpeed: ${device.name} @ ${res.brightness}%`)
          service.getCharacteristic(Characteristic.RotationSpeed).updateValue(res.brightness)
          callback(null, res.brightness)
        })
        .catch((err) => this.handleError('onGetRotationSpeed', err, callback))
    }
  }

  // switch RotationSpeed setter closure with service, device and token
  onSetRotationSpeed(service, device, token) {
    return function (brightness, callback) {
      return this.putIfConnected(device, { brightness })
        .then((res) => {
          this.log.info(`onSetRotationSpeed: ${device.name} @ ${res.brightness}%`)
          service.getCharacteristic(Characteristic.RotationSpeed).updateValue(res.brightness)
          callback()
        })
        .catch((err) => this.handleError('onSetRotationSpeed', err, callback))
    }
  }

  async addAccessory(device, token) {
    this.log.info(`addAccessory ${device.name}`)

    // generate uuid based on device serial and create accessory
    const uuid = UUID.generate(device.serial)
    const accessory = new this.api.platformAccessory(device.name, uuid)

    // save device and token information to context for later use
    accessory.context.device = device
    accessory.context.token = token

    // save device info to AccessoryInformation service (which always exists?)
    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, device.name)
      .setCharacteristic(Characteristic.SerialNumber, device.serial)
      .setCharacteristic(Characteristic.Manufacturer, device.manufacturer)
      .setCharacteristic(Characteristic.Model, device.model)
      .setCharacteristic(Characteristic.FirmwareRevision, device.version)

    // setupService adds services, characteristics and getters/setters
    this.setupService(accessory)
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])

    // add configured accessory
    this.accessories.push(accessory)
    this.log.debug(`Finished adding accessory ${device.name}`)
  }

  // set up cached accessories
  async configureAccessory(accessory) {
    this.log.debug(`configureAccessory: ${accessory.displayName}`)
    this.setupService(accessory)
    this.accessories.push(accessory)
  }

  // fetch the status of a device to populate power state and brightness
  async getStatus(device, token) {
    this.log.debug(`getStatus: ${device.name}`)
    try {
      const status = await this.withAuth((authToken) =>
        Leviton.getIotSwitch({
          switchID: device.id,
          token: authToken,
        })
      )
      if (status.connected === false) {
        this.log.warn(`${device.name} is offline in the Leviton cloud, HomeKit will show No Response until it reconnects`)
      }
      return status
    } catch (err) {
      this.log.error(`getStatus error for ${device.name}: ${err.message}`)
      return {}
    }
  }

  // setup service function
  async setupService(accessory) {
    this.log.debug(`setupService: ${accessory.displayName}`)

    // get device and token out of context to update status
    const device = accessory.context.device
    const token = accessory.context.token

    // Get the model number
    this.log.debug(`Device Model: ${device.model}`)

    switch (device.model) {
      case 'DW4SF': // Fan Speed Control
        this.setupFanService(accessory)
        break
      case 'DWVAA': // Voice Dimmer with Amazon Alexa
      case 'DW1KD': // 1000W Dimmer
      case 'DW6HD': // 600W Dimmer
      case 'D26HD': // 600W Dimmer (2nd Gen)
      case 'D23LP': // Plug-In Dimmer (2nd Gen)
      case 'DW3HL': // Plug-In Dimmer
        this.setupLightbulbService(accessory)
        break
      case 'DW15R': // Tamper Resistant Outlet
      case 'DW15A': // Plug-in Outlet (1/2 HP)
      case 'DW15P': // Plug-in Outlet (3/4 HP)
        this.setupOutletService(accessory)
        break
      default:
        // Set up anything else as a simple switch (i.e. - DW15S, etc)
        this.setupSwitchService(accessory)
        break
    }
  }

  async setupSwitchService(accessory) {
    this.log.debug(`Setting up device as Switch: ${accessory.displayName}`)

    // get device and token out of context to update status
    const device = accessory.context.device
    const token = accessory.context.token
    const status = await this.getStatus(device, token)

    // get the accessory service, if not add it
    const service =
      accessory.getService(Service.Switch, device.name) || accessory.addService(Service.Switch, device.name)

    // add handlers for on/off characteristic, set initial value
    service
      .getCharacteristic(Characteristic.On)
      .on('get', this.onGetPower(service, device, token).bind(this))
      .on('set', this.onSetPower(service, device, token).bind(this))
      .updateValue(status.power === 'ON' ? true : false)
  }

  async setupOutletService(accessory) {
    this.log.debug(`Setting up device as Outlet: ${accessory.displayName}`)

    // get device and token out of context to update status
    const device = accessory.context.device
    const token = accessory.context.token
    const status = await this.getStatus(device, token)

    // get the accessory service, if not add it
    const service =
      accessory.getService(Service.Outlet, device.name) || accessory.addService(Service.Outlet, device.name)

    // add handlers for on/off characteristic, set initial value
    service
      .getCharacteristic(Characteristic.On)
      .on('get', this.onGetPower(service, device, token).bind(this))
      .on('set', this.onSetPower(service, device, token).bind(this))
      .updateValue(status.power === 'ON' ? true : false)
  }

  async setupLightbulbService(accessory) {
    this.log.debug(`Setting up device as Lightbulb: ${accessory.displayName}`)

    // get device and token out of context to update status
    const device = accessory.context.device
    const token = accessory.context.token
    const status = await this.getStatus(device, token)

    // get the accessory service, if not add it
    const service =
      accessory.getService(Service.Lightbulb, device.name) || accessory.addService(Service.Lightbulb, device.name)

    // add handlers for on/off characteristic, set initial value
    service
      .getCharacteristic(Characteristic.On)
      .on('get', this.onGetPower(service, device, token).bind(this))
      .on('set', this.onSetPower(service, device, token).bind(this))
      .updateValue(status.power === 'ON' ? true : false)

    // set handlers for brightness, set initial value and min/max bounds
    service
      .getCharacteristic(Characteristic.Brightness)
      .on('get', this.onGetBrightness(service, device, token).bind(this))
      .on('set', this.onSetBrightness(service, device, token).bind(this))
      .setProps({
        minValue: status.minLevel ?? 1,
        maxValue: status.maxLevel ?? 100,
        minStep: 1,
      })
      .updateValue(status.brightness)
  }

  async setupFanService(accessory) {
    this.log.debug(`Setting up device as Fan: ${accessory.displayName}`)

    // get device and token out of context to update status
    const device = accessory.context.device
    const token = accessory.context.token
    const status = await this.getStatus(device, token)

    // get the accessory service, if not add it
    const service = accessory.getService(Service.Fan, device.name) || accessory.addService(Service.Fan, device.name)

    // add handlers for on/off characteristic, set initial value
    service
      .getCharacteristic(Characteristic.On)
      .on('get', this.onGetPower(service, device, token).bind(this))
      .on('set', this.onSetPower(service, device, token).bind(this))
      .updateValue(status.power === 'ON' ? true : false)

    // set handlers for brightness, set initial value and min/max bounds
    service
      .getCharacteristic(Characteristic.RotationSpeed)
      .on('get', this.onGetRotationSpeed(service, device, token).bind(this))
      .on('set', this.onSetRotationSpeed(service, device, token).bind(this))
      .setProps({
        minValue: 0,
        maxValue: status.maxLevel,
        minStep: status.minLevel,
      })
      .updateValue(status.brightness)
  }

  // remove accessories and unregister
  removeAccessories() {
    this.log.info('Removing all accessories')
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories)
    this.accessories.splice(0, this.accessories.length)
  }
}

module.exports = function (homebridge) {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  Accessory = homebridge.hap.Accessory
  UUID = homebridge.hap.uuid
  HapStatusError = homebridge.hap.HapStatusError
  HAPStatus = homebridge.hap.HAPStatus
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LevitonDecoraSmartPlatform, true)
}
