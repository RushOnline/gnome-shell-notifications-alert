/*
 * Copyright (C) 2012 Thiago Bellini <hackedbellini@gmail.com>
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *
 * Some parts of this code were forked from message-notifier:
 *   https://extensions.gnome.org/extension/150/message-notifier/
 * The idea of setting the menu red were inspired by pidgin-persistent-notification:
 *   https://extensions.gnome.org/extension/170/pidgin-peristent-notification
 *
 */

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const GnomeSession = imports.misc.gnomeSession;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;

const SETTING_BLINK_RATE = 'blinkrate';
const SETTING_COLOR = 'color';
const SETTING_CHAT_ONLY = 'chatonly';
const SETTING_FORCE = 'force';

let settings, messageStyleHandler;
let originalCountUpdated, originalDestroy;

function _MessageStyleHandler() {

  this._loopTimeoutId = null;
  this._oldStyle = null;
  this._hasStyleAdded = false;
  this._presence = new GnomeSession.Presence(
    Lang.bind(this, function(proxy, error) {
      if (error) {
        logError(error, 'Error while reading gnome-session presence');
        return;
      }
  }));

  /*
     Public API
  */

  this.enable = function() {
    this._presence.connectSignal(
      'StatusChanged', Lang.bind(this, function(proxy, senderName, [status]) {
        this._presence.status = status;
        this._onNotificationsSwitchToggled();
    }));

    // Connect settings change events, so we can update message style
    // as soon as the user makes the change
    settings.connect("changed::" + SETTING_COLOR,
                     Lang.bind(this, this._onSettingsChanged));
    settings.connect("changed::" + SETTING_CHAT_ONLY,
                     Lang.bind(this, this._onSettingsChanged));
    settings.connect("changed::" + SETTING_FORCE,
                     Lang.bind(this, this._onSettingsChanged));
    settings.connect("changed::" + SETTING_BLINK_RATE,
                     Lang.bind(this, this._onSettingsChanged));

    // Check for existing message counters when extension were
    // loaded on an already running shell.
    this.updateMessageStyle();
  }

  this.disable = function() {
    this._removeMessageStyle();
  }

  this.updateMessageStyle = function() {
    this.notificationStatus =
      (this._presence.status != GnomeSession.PresenceStatus.BUSY);
    let sources = Main.messageTray.getSources();

    if (settings.get_boolean(SETTING_FORCE) || this.notificationStatus) {
      let chatOnly = settings.get_boolean(SETTING_CHAT_ONLY);

      for (let i = 0; i < sources.length; i++) {
        let source = sources[i];

        if (chatOnly && !source.isChat) {
          // The user choose to only be alerted by real chat notifications
          continue;
        }
        if (source.isMuted) {
          // Do not alert for muted notifications
          continue;
        }
        if (this._hasNotifications(source)) {
          this._addMessageStyle();
          return;
        }
      }
    }
    // If for above ended without adding the style, that means there's
    // no counter and we need to remove the message style.
    this._removeMessageStyle();
  }

  /*
     Private
  */

  this._hasNotifications = function(source) {
    // indicatorCount returns the total notifications that are not
    // transient neither resident. That's exactly what we want here.
    return source.indicatorCount > 0;
  }

  this._loopStyle = function(toggle) {
    let userMenu = Main.panel.statusArea.aggregateMenu;
    let loopDelay = settings.get_int(SETTING_BLINK_RATE);
    let willLoop = loopDelay > 0;

    if (!this._hasStyleAdded) {
      // notifications may have been cleared since loop timer was added
      return;
    }

    let style = willLoop && toggle ?
      this._oldStyle :
      "color: " + settings.get_string(SETTING_COLOR);
    userMenu._indicators.style = style;

    // loop it
    if (loopDelay > 0) {
      if (this._loopTimeoutId != null) {
        // Prevent more than one loop being executed
        Mainloop.source_remove(this._loopTimeoutId);
      }
      // For some reason, trying to use this directly above
      // will result in "this._loopStyle is not a function" error
      let that = this;
      this._loopTimeoutId = Mainloop.timeout_add(
        loopDelay, function() {
          that._loopStyle(!toggle)
        });
    }
  }

  this._addMessageStyle = function() {
    let userMenu = Main.panel.statusArea.aggregateMenu;

    if (!this._hasStyleAdded) {
      // Only cache oldStyle when when adding style the first time.
      // Do this to support change the notification color as soon the
      // setting changes.
      let oldStyle = userMenu._indicators.get_style();
      if (oldStyle != settings.get_string(SETTING_COLOR)) {
        // Changing SETTING_BLINK_RATE from something to 0 can produce
        // a race condition where the loop stops when the style is the
        // one we we added. Prevent it for overwriting this._oldStyle
        this._oldStyle = oldStyle;
      }
    }

    this._hasStyleAdded = true;
    this._loopStyle(false);
  }

  this._removeMessageStyle = function() {
    if (this._loopTimeoutId != null) {
      // Prevent a possible race condition
      Mainloop.source_remove(this._loopTimeoutId);
    }

    let userMenu = Main.panel.statusArea.aggregateMenu;
    userMenu._indicators.style = this._oldStyle;
    this._oldStyle = null;
    this._hasStyleAdded = false;
  }

  /*
     Callbacks
  */

  this._onSettingsChanged = function() {
    this.updateMessageStyle();
  }

  this._onNotificationsSwitchToggled = function() {
    this.updateMessageStyle();
  }
}

/*
   Monkey-patchs for MessageTray.Source
*/

function _countUpdated() {
  originalCountUpdated.call(this);

  messageStyleHandler.updateMessageStyle();
}

function _destroy() {
  originalDestroy.call(this);

  messageStyleHandler.updateMessageStyle();
}

/*
   Shell-extensions handlers
*/

function init() {
  Lib.initTranslations(Me);
  settings = Lib.getSettings(Me);
}

function enable() {
  messageStyleHandler = new _MessageStyleHandler();

  originalCountUpdated = MessageTray.Source.prototype.countUpdated;
  originalDestroy = MessageTray.Source.prototype.destroy;

  MessageTray.Source.prototype.countUpdated = _countUpdated;
  MessageTray.Source.prototype.destroy = _destroy;

  messageStyleHandler.enable();
}

function disable() {
  MessageTray.Source.prototype.countUpdated = originalCountUpdated;
  MessageTray.Source.prototype.destroy = originalDestroy;

  messageStyleHandler.disable();
}
