// modemManager.js
// const getConnectionHistoryByPhone = require("../usecases/getConnectionHistoryByPhone.js");
const deleteMessagesFromAllPhones  = require("./usecases/deleteMessagesFromAllPhones.js");
const getBalanceByPhone            = require("./usecases/getBalanceByPhone.js");
const getBalanceByAllPhones        = require("./usecases/getBalanceByAllPhones.js");
const sendSMSByPhone               = require("./usecases/sendSMSByPhone.js");
const sendSMS                      = require("./usecases/sendSMS.js");
const getCode                      = require("./usecases/getCode.js");
const refreshModem                 = require("./usecases/refreshModem.js");
const getMessage                   = require("./usecases/getMessage.js");
const ussd                         = require("serialport-gsm/lib/functions/ussd.js");
const prisma                       = require("../utils/db");
const logger                       = require("../utils/logger");

const serialportgsm = require("serialport-gsm");
const { exec }     = require("child_process");
const { Modem }    = serialportgsm;

const DEFAULT_RECONNECT_DELAY = 2500;       // начальная задержка переподключения
const MAX_RECONNECT_DELAY     = 40_000;     // максимальная задержка переподключения
const MAX_RETRIES             = 3;          // число попыток переподключения

const dotenv = require('dotenv');
dotenv.config();

class ModemManager {
  constructor() {
    this.modems = new Map();               // карта «port → entry»
  }

  // Формирует объект для логирования
  loggerFields(entry = {}, error = null) {
    const base = { port: entry?.port, imei: entry?.imei, phone: entry?.phone };
    return error ? { ...base, error: {error} } : base;
  }

  // Утилита для паузы
  async sleep(ms = 4000) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Обнаружение и инициализация модемов
  addModems(options) {
    serialportgsm.list((error, devices) => {
      if (error) {
        logger.error({ error: error }, "Не удалось получить список портов");
        return;
      }
      devices.forEach((dev) => {
        if (!dev.pnpId) return;
        logger.info({ port: dev.path }, "Найден GSM-модем");
        this._addModem(dev.path, options);
      });
    });
  }

  // Добавление одного модема в менеджер
  async _addModem(port, options) {
    const entry = { port, options, reconnectDelay: DEFAULT_RECONNECT_DELAY, retryCount: 0, imei: null, phone: null };
    this.modems.set(port, entry);
    await this._createAndOpen(entry);
  }

  // Получение IMEI из модема
  _getModemSerial(entry, timeout = 1000) {
    return new Promise((resolve, reject) => {
      entry.modem.getModemSerial((data) => {
        if (data?.data?.modemSerial) {
          resolve(data.data.modemSerial);
        } else {
          logger.error(this.loggerFields(entry), "Нет IMEI в ответе");
          reject(new Error("No IMEI"));
        }
      }, timeout);
    });
  }

  // Запрос номера SIM через USSD
  async _getSubscriberNumber(entry, timeout = 50_000, retry = 1) {
    const { modem } = entry;
    return new Promise((resolve, reject) => {
      const onNewMessage = (msgs) => {
        clearTimeout(timer);
        modem.removeListener("onNewMessage", onNewMessage);
        const text = msgs[0]?.message || "";
        const match = text.match(/\+?\d{7,15}/);
        if (match) return resolve(match[0]);
        logger.error(this.loggerFields(entry), "Не нашли номер в тексте USSD-ответа");
        reject(new Error("No subscriber number"));
      };

      const onTimeout = () => {
        modem.removeListener("onNewMessage", onNewMessage);
        logger.warn(this.loggerFields(entry), "Timeout при получении номера SIM");
        reject(new Error("Subscriber timeout"));
      };

      const timer = setTimeout(onTimeout, timeout);
      modem.once("onNewMessage", onNewMessage);
      modem.sendUSSD("*111*0887#", (data) => {
        if (data?.status === "fail") {
          clearTimeout(timer);
          modem.removeListener("onNewMessage", onNewMessage);
          logger.error(this.loggerFields(entry), "USSD-запрос не прошёл: fail");
          reject(new Error("USSD fail"));
        }
      });
    });
  }

  // Сохранение входящего SMS в БД
  async _saveIncoming(entry, { sender, dateTimeSent, text }) {
    try {
      const device = await prisma.modemDevice.findUnique({ where: { imei: entry.imei } });
      const simId  = device.currentSimId;
      await prisma.smsIncomingHistory.create({ data: { modemDeviceId: device.id, simCardId: simId, sender, receivedAt: dateTimeSent, text } });
      logger.info(this.loggerFields(entry), "Сообщение сохранено");
    } catch (error) {
      logger.info(this.loggerFields(entry, error), "Ошибка сохранения сообщения");
    }
  }

  // Очистка всех SMS на SIM
  async _deleteMessages(entry) {
    try {
      await new Promise((resolve, reject) => entry.modem.deleteAllSimMessages((data) => data ? resolve() : reject()));
      logger.info(this.loggerFields(entry), "Сообщения успешно удалены");
    } catch (e) {
      logger.error(this.loggerFields(entry, e), "Ошибка при удалении сообщений");
    }
  }

  async _getVendor(entry) {
    const { modem } = entry;
    return new Promise((resolve, reject) => {
      modem.executeCommand('AT+COPS?', (result, err) => {
        if (err) {
          logger.error(this.loggerFields(entry, e), "Ошибка при получении вендора");
          reject()
        } else {
          let resultStr = result.data.result;
          let match = resultStr.match(/"([^"]+)"/);
          let vendor = match ? match[1] : null;
          logger.info(this.loggerFields(entry), `Вендор: ${vendor}`);
          resolve(vendor)
        }
      });
    });
  }

  async _getLogs(page=1, numbers=30) {
    let logs
    try {
      let firstLine = page > 1 ? (page * numbers) - numbers + 1 : 1
      let lastLine = page * numbers
      await new Promise((resolve, reject) => {
        exec(`tac ${process.env.LOG_FILE} | sed -n '${firstLine},${lastLine}p' | tac`, (err, stdout, stderr) => {
          if (err) {
            logger.error("Ошибка получения логов");
            return reject(err);
          }
          if (stderr) logger.warn({stderr});
          logs = stdout
          logger.info("Логи получены");
          resolve();
        });
      });
    } catch (error) {
      logger.error({error});
    }
    return logs
  }

  // Получить entry по номеру SIM
  async _getEntry(phone) {
    let entry = null;
    try {
      const sim = await prisma.simCard.findUnique({ where: { phoneNumber: phone } });
      if (!sim) {
        logger.error(this.loggerFields(), `SIM ${phone} не найдена`);
        return null;
      }
      const device = await prisma.modemDevice.findFirst({ where: { currentSimId: sim.id } });
      if (!device) {
        logger.error(this.loggerFields(), `SIM ${phone} не привязана ни к одному модему`);
        return null;
      }
      entry = this.modems.get(device.serialNumber);
      if (!entry) logger.error(this.loggerFields(), `Modem не запущен на ${device.serialNumber}`);
    } catch (e) {
      logger.error(this.loggerFields(entry, e), `Ошибка _getEntry для SIM ${phone}`);
    }
    return entry;
  }

  // Переподключение USB программно
  async _replugUSB(port, entry) {
    const shortPort = port.replace("/dev/", "");
    try {
      await new Promise((resolve, reject) => {
        exec(`sudo ${process.env.REPLUG_SCRIPT} ${shortPort}`, (err, stdout, stderr) => {
          if (err) {
            logger.error(this.loggerFields(entry, err), "Ошибка программного переподключения порта");
            return reject(err);
          }
          if (stderr) logger.warn(this.loggerFields(entry), stderr);
          logger.info(this.loggerFields(entry), "Порт успешно перезагружен");
          resolve();
        });
      });
    } catch (e) {
      logger.error(this.loggerFields(entry, e), "Ошибка при переподключении USB");
    }
  }

  // Основная логика открытия и пересоздания модема
  async _createAndOpen(entry) {
    const { port, options } = entry;
    const modem = Modem();
    modem.removeAllListeners();
    ussd(modem);
    entry.modem       = modem;
    entry.initialized ||= false;

    // Функция повторного открытия с backoff
    const tryOpen = async () => {
      try {
        await new Promise((res, rej) => modem.open(port, options, (err) => err ? rej(err) : res()));
      } catch (e) {
        logger.warn(this.loggerFields(entry, e), "Ошибка открытия, retry");
        entry.reconnectDelay = Math.min(entry.reconnectDelay * 2, MAX_RECONNECT_DELAY);
        setTimeout(tryOpen, entry.reconnectDelay);
      }
    };
    tryOpen();

    // Обработчик успешного открытия
    modem.on("open", async () => {
      await this.sleep();

      // 1) Инициализация модема
      modem.initializeModem(async (msg, e) => { 
        if (e) {
          logger.error(this.loggerFields(entry, e), "Не удалось инициализировать модем");
          try {
            modem.close();
          } catch (error) {
            logger.error(this.loggerFields(entry, error), "Ошибка при закрытии модема");
          }
          return
        }

        logger.info(this.loggerFields(entry), "Модем инициализирован");

        // 2) Включение PDU-режима
        await this.sleep();
        modem.setModemMode((msg) => { logger.info(this.loggerFields(entry), "Включен PDU режим")}, "PDU")


        // get the Network signal strength
        await this.sleep();
        modem.getNetworkSignal((result, e) => {
          if (e) {
            logger.error(this.loggerFields(entry, e), "Не удалось инициализировать модем");
            return modem.close()
          } else {
            logger.info(this.loggerFields(entry), `Signal Strength: ${JSON.stringify(result.data)}`)
          }
        });

        // 3) Очистка входящих
        await this.sleep();
        await this._deleteMessages(entry)

        // 4) Сброс счётчиков при первом open
        if (!entry.initialized) {
          entry.initialized   = true;
          entry.retryCount    = 0;
          entry.reconnectDelay= DEFAULT_RECONNECT_DELAY;
          logger.info(this.loggerFields(entry), "Модем открыт впервые, сброшены счётчики");
        } else {
          logger.info(this.loggerFields(entry), "Модем переподключён");
        }

        // 5) Чтение IMEI
        await this.sleep();
        try {
          entry.imei = await this._getModemSerial(entry);
          logger.info(this.loggerFields(entry), "Прочитан IMEI");
        } catch (e) {
          logger.error(this.loggerFields(entry, e), "Не удалось получить IMEI");
          return modem.close();
        }

        // 6) Чтение номера SIM
        await this.sleep();
        try {
          entry.phone = `+${await this._getSubscriberNumber(entry)}`;
          logger.info(this.loggerFields(entry), "Прочитан номер SIM");
        } catch {
          // retry once
          await this.sleep();
          try {
            entry.phone = `+${await this._getSubscriberNumber(entry, 20_000, 2)}`;
            logger.info(this.loggerFields(entry), "Прочитан номер SIM co второго раза");
          } catch (e) {
            logger.error(this.loggerFields(entry, e), "Не удалось получить номер SIM второй раз");
            return modem.close()
          }
        }

        let vendor = await this._getVendor(entry)
        vendor = vendor ? vendor : "unknown";

        // 7) Upsert устройств в БД
        const device = await prisma.modemDevice.upsert({
          where: { imei: entry.imei },
          update:{ status: "connected", serialNumber: port },
          create:{ imei: entry.imei, serialNumber: port, status: "connected" }
        });

        // 8) Upsert SIM и связь
        if (entry.phone) {
          const sim = await prisma.simCard.upsert({
            where: { phoneNumber: entry.phone },
            update:{ status: "active", provider: vendor, busy: false },
            create:{ phoneNumber: entry.phone, provider: vendor, status: "active" }
          });
          await prisma.modemDevice.update({ where:{ id: device.id }, data:{ currentSimId: sim.id } });
          await prisma.modemSimHistory.create({ data:{ modemId: device.id, simId: sim.id } });
        }

        await this.sleep();
        // 9) Проверка баланса
        await this.getBalanceByPhone(entry.phone);
      });

    });

    // Обработчик закрытия порта
    modem.on("close", async () => {
      if (++entry.retryCount > MAX_RETRIES) {
        logger.error(this.loggerFields(entry), `Достигнуто макс. попыток (${MAX_RETRIES})`);
        modem.removeAllListeners();
        return;
      }
      modem.removeAllListeners();

      if (entry.retryCount === MAX_RETRIES) {
        logger.warn(this.loggerFields(entry), "Программный переподключ USB");
        await this._replugUSB(entry.port, entry);
      } else {
        logger.warn(this.loggerFields(entry), "Попытка переподключения модема");
      }

      if (entry.imei) {
        try {
          const dev = await prisma.modemDevice.findUnique({ where:{ imei: entry.imei } });
          await prisma.modemSimHistory.updateMany({ where:{ modemId: dev.id, disconnectedAt:null }, data:{ disconnectedAt: new Date() } });
          await prisma.modemDevice.update({ where:{ id: dev.id }, data:{ status:"disconnected" } });
        } catch (e) {
          logger.error(this.loggerFields(entry, e), "Ошибка маркировки отключения");
        }
      }

      entry.reconnectDelay = Math.min(entry.reconnectDelay * 2, MAX_RECONNECT_DELAY);
      logger.info({ port: entry.port, retry: entry.retryCount, delay: entry.reconnectDelay }, "Переподключение");
      setTimeout(() => this._createAndOpen(entry), entry.reconnectDelay);
    });

    // Глобальный хендлер ошибок модема
    modem.on("error", (e) => {
      try {
        modem.close();
      } catch (error) {
        logger.error(this.loggerFields(entry, error), "Ошибка при закрытии модема");
      }
      logger.error(this.loggerFields(entry, e), "Ошибка модема");
    });

    modem.on('onMemoryFull', data => {
      logger.warn(this.loggerFields(entry), "Память переполнена");
      this._deleteMessages(entry)
    });
  }

  /* Use-case методы */
  async getCode(phone) {
    const entry = await this._getEntry(phone);
    return getCode(entry, this._saveIncoming.bind(this), this._deleteMessages.bind(this));
  }

  async getMessage(phone) {
    const entry = await this._getEntry(phone);
    return getMessage(entry, this._saveIncoming.bind(this), this._deleteMessages.bind(this));
  }

  async sendSMSByPhone(fromPhone, to, text) {
    const entry = await this._getEntry(fromPhone);
    return sendSMSByPhone(entry, to, text, this._deleteMessages.bind(this));
  }

  async sendSMS(to, text) {
    return sendSMS(to, text, this.modems, this._deleteMessages.bind(this));
  }

  async getBalanceByPhone(fromPhone) {
    const entry = await this._getEntry(fromPhone);
    return getBalanceByPhone(entry);
  }

  async getBalanceByAllPhones() {
    return getBalanceByAllPhones(this._getEntry.bind(this));
  }

  async deleteMessagesFromAllPhones() {
    return deleteMessagesFromAllPhones(this._deleteMessages.bind(this), this._getEntry.bind(this));
  }

  async refreshModem(phones, options) {
    return refreshModem(phones, this._addModem.bind(this), options, this._getEntry.bind(this));
  }

  async getConnectionHistoryByPhone(phone) {
    return getConnectionHistoryByPhonegetConnectionHistoryByPhone(phone);
  }
}

module.exports = ModemManager;
