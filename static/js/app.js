webpackJsonp([1],[
/* 0 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(global) {/*global window*/
	'use strict';

	var $ = __webpack_require__(3);
	var _ = __webpack_require__(5);
	var EventEmitter = __webpack_require__(4);
	var URL = __webpack_require__(100);

	var queryStringUtil = __webpack_require__(93);

	var PersistentConnection = __webpack_require__(94);
	var JsonPerLineParser = __webpack_require__(95);

	var Dashboard = __webpack_require__(96);
	var DashboardDataStore = __webpack_require__(97);
	var DashboardLayoutStore = __webpack_require__(98);

	__webpack_require__(101);


	var logger = __webpack_require__(99);

	var logPrefix = '[frontend] ';


	logger.log(logPrefix + 'Loaded at ' + (new Date()));


	/**
	 * Copies all HTMl attributes from one DOM node to another.
	 */
	function copyHtmlAttributes(srcEl, dstEl) {
		for (var atts = srcEl.attributes, ic = atts.length, i = 0; i < ic; ++i) {
			dstEl.setAttribute(atts[i].nodeName, atts[i].nodeValue);
		}
	}


	function init() {
		var dispatcher = new EventEmitter();
		
		var config = null;
		var dataHostnamesRoundRobin = 0;
		
		var backendApi = {
			/**
			 * Loads the config from the backend, then loads the layout.
			 * The config includes:
			 * - {string} layout_url The URL of the dashboard layout, the base for other URLs.
			 * - {Array.<string>} [data_hostnames] An array of hostnames that resolve to
			 *     the backend to fool the browser's domain connection limit.
			 * - {string} [dashboard_template] The HTML template of the dashboard (full HTML document).
			 *     Replaces the current HTMl document contents. Should contain an HTML element
			 *     with `knsh-dashboard-root` class. May also contain CSS styles and JS scripts.
			 */
			loadConfig: function () {
				// Obtain the base URL of the dashboard.
				var baseUrl = window.location.pathname;
				
				// The backend must guarantee the base URL to have a trailing slash,
				// otherwise there could be issues with relative URL resolution done by
				// the browser (e.g. from the stylesheets).
				if (baseUrl.lastIndexOf('/') !== baseUrl.length-1) {
					logger.error(logPrefix + 'The base path must have a trailing slash: ' + baseUrl);
					window.alert('The base path must have a trailing slash: ' + baseUrl);
					return;
				}
				
				// Build the config URL.
				var configUrl = baseUrl + 'config';
				
				// Load the config from the backend.
				$.ajax({
					url: configUrl,
					dataType: 'json'
				}).then(function (response) {
					config = _.extend({
						layout_url: null,
						data_hostnames: [],
						dashboard_template: ''
					}, response && response.config);
					
					if (!config.layout_url) {
						logger.error(logPrefix + 'Empty "layout_url" in config from ' + configUrl + ':', config);
						window.alert('Got invalid config from ' + configUrl + '.');
						return;
					}
					
					if (config.dashboard_template) {
						// Parse the HTML template string into a DOM document.
						var templateDocument = window.document.implementation.createHTMLDocument('');
						templateDocument.open();
						templateDocument.write(config.dashboard_template);
						templateDocument.close();
						
						// Prepare to move elements from the template to the current document.
						var $src = $(templateDocument);
						var $srcHead = $src.find('head');
						var $srcBody = $src.find('body');
						
						var $dst = $(window.document);
						var $dstHead = $dst.find('head');
						var $dstBody = $dst.find('body');
						
						// Move the template elements to the current document.
						$dstHead.append( $srcHead.contents() );
						$dstBody.empty().append( $srcBody.contents() );
						
						// Copy the attribute values on the root elements.
						copyHtmlAttributes($srcHead[0], $dstHead[0]);
						copyHtmlAttributes($srcBody[0], $dstBody[0]);
					}
					else {
						// The empty template is not a critical error, we'll use the default.
						logger.error(logPrefix + 'Empty "dashboard_template" in config from ' + configUrl + ':', config);
					}
					
					// The `knsh-dashboard-root` element comes from the `dashboard_template`.
					// If the template is empty, the element from the default HTML is used.
					dashboard.mount( $('.knsh-dashboard-root') );
					
					// Load the layout after the dashboard is mounted to the template.
					backendApi.loadLayout();
				}, function (jqXHR) {
					logger.error(logPrefix + 'Failed to load config from ' + configUrl + ':', jqXHR);
					window.alert('An error occurred while loading config from ' + configUrl + '.');
				});
			},
			
			/**
			 * Loads the layout via the URL from the config.
			 * The config must be loaded before.
			 */
			loadLayout: function () {
				if (!config) {
					logger.error(logPrefix + 'The config is not loaded.');
					window.alert('The config is not loaded.');
					return;
				}
				
				var layoutUrl = config.layout_url;
				
				$.ajax({
					url: layoutUrl,
					dataType: 'json'
				}).then(function (response) {
					var layout = response.layout;
					
					if (layout) {
						logger.log(logPrefix + 'Loaded layout from ' + layoutUrl + ':', layout);
						
						dispatcher.emit('receive-layout', {
							layoutUrl: layoutUrl,
							layout: layout
						});
					}
				}, function (jqXHR) {
					logger.error(logPrefix + 'Failed to load layout from ' + layoutUrl + ':', jqXHR);
					window.alert('An error occurred while loading layout from ' + layoutUrl + '.');
				});
			},
			
			/**
			 * Loads the metadata for a single layout cell.
			 * The config must be loaded before.
			 */
			loadMeta: function (metaUrl) {
				if (!config) {
					logger.error(logPrefix + 'The config is not loaded.');
					window.alert('The config is not loaded.');
					return;
				}
				
				var metaUrlFull = config.layout_url + metaUrl;
				
				$.ajax({
					url: metaUrlFull,
					dataType: 'json'
				}).then(function (response) {
					var meta = response.meta;
					
					if (meta) {
						logger.log(logPrefix + 'Loaded meta from ' + metaUrlFull + ':', meta);
						
						dispatcher.emit('receive-meta', {
							metaUrl: metaUrl,
							meta: meta
						});
					}
				}, function (jqXHR) {
					logger.error(logPrefix + 'Failed to load meta from ' + metaUrlFull + ':', jqXHR);
					window.alert('An error occurred while loading meta from ' + metaUrlFull + '.');
				});
			},
			
			/**
			 * Connects to the data stream with a persistent connection
			 * and triggers updates when new data arrives.
			 * Uses "dataHostnames" to find the hostname to connect to.
			 * The config must be loaded before.
			 */
			streamData: function (dataUrl, timeInterval) {
				if (!config) {
					logger.error(logPrefix + 'The config is not loaded.');
					window.alert('The config is not loaded.');
					return;
				}
				
				var stopping = false;
				
				if (typeof timeInterval !== 'number' || timeInterval < 0) {
					timeInterval = 0;
				}
				
				var queryParams = {
					since: ((new Date()).getTime() - timeInterval)
				};
				
				var persistentConnection = new PersistentConnection({
					logPrefix: 	logPrefix + ' [' + dataUrl + '] [PersistentConnection] '
				});
				
				var jsonPerLineParser = new JsonPerLineParser({
					logPrefix: 	logPrefix + ' [' + dataUrl + '] [JsonPerLineParser] '
				});
				
				function reconnectOnError() {
					if (!stopping && !persistentConnection.isConnecting()) {
						persistentConnection.reconnect();
					}
				}
				
				persistentConnection.on('connected', function (data) {
					jsonPerLineParser.reset();
				});
				persistentConnection.on('data', function (data) {
					jsonPerLineParser.write(data);
				});
				persistentConnection.on('end', reconnectOnError);
				persistentConnection.on('error', reconnectOnError);
				
				jsonPerLineParser.on('data', function (data) {
					// Support both raw '{"x":1,"y":2}' and Bricks' '{"point":{"x":1,"y":2}}'.
					var point = (data ? (data.point || data) : data);
					if (point && typeof point.x === 'number') {
						// Advance the time that will go in the next request
						// to the latest data sample time.
						// HACK: Add a small number to avoid last point duplicate.
						queryParams.since = point.x + 1e-3;
						persistentConnection.setUrl(
							queryStringUtil.extend(
								persistentConnection.getUrl(),
								queryParams
							)
						);
						
						// Notify that the data has been received:
						dispatcher.emit('receive-data', {
							dataUrl: dataUrl,
							data: [ point ]
						});
					}
					else {
						logger.error(logPrefix + ' [' + dataUrl + '] Invalid data format:', data);
					}
				});
				jsonPerLineParser.on('error', reconnectOnError);
				
				var dataUrlFull = config.layout_url + dataUrl;
				
				// Use the next hostname from the config, if available.
				var dataUrlParsed = URL.parse(dataUrlFull);
				var dataHostnames = config.data_hostnames;
				if (
					dataHostnames && dataHostnames.length > 0
					&& (dataUrlParsed.hostname === 'localhost' || (
						!dataUrlParsed.hostname
						&& window.location.hostname === 'localhost'
					))
				) {
					dataUrlParsed.protocol = dataUrlParsed.protocol || window.location.protocol;
					dataUrlParsed.hostname = dataHostnames[dataHostnamesRoundRobin];
					dataUrlParsed.port = dataUrlParsed.port || window.location.port;
					dataHostnamesRoundRobin++;
					if (dataHostnamesRoundRobin >= dataHostnames.length) {
						dataHostnamesRoundRobin = 0;
					}
					dataUrlFull = URL.format(dataUrlParsed);
				}
				
				persistentConnection.connect(dataUrlFull, queryParams);
				
				return {
					stop: function () {
						stopping = true;
						persistentConnection.disconnect();
					}
				};
			}
		};
		
		var dashboardDataStore = new DashboardDataStore(dispatcher, backendApi);
		
		var dashboardLayoutStore = new DashboardLayoutStore(dispatcher, backendApi);
		
		var dashboard = new Dashboard({
			getDataStore: function () { return dashboardDataStore; },
			getLayoutStore: function () { return dashboardLayoutStore; }
		}, {
		});
		
		$(global).on('load resize orientationchange', _.throttle(function () {
			dispatcher.emit('resize-window');
		}, 50));
		
		logger.log(logPrefix + 'Initialized at ' + (new Date()));
		
		backendApi.loadConfig();
	}

	$(global).on('load', init);
	
	/* WEBPACK VAR INJECTION */}.call(exports, (function() { return this; }())))

/***/ },
/* 1 */,
/* 2 */,
/* 3 */,
/* 4 */,
/* 5 */,
/* 6 */,
/* 7 */,
/* 8 */,
/* 9 */,
/* 10 */,
/* 11 */,
/* 12 */,
/* 13 */,
/* 14 */,
/* 15 */,
/* 16 */,
/* 17 */,
/* 18 */,
/* 19 */,
/* 20 */,
/* 21 */,
/* 22 */,
/* 23 */,
/* 24 */,
/* 25 */,
/* 26 */,
/* 27 */,
/* 28 */,
/* 29 */,
/* 30 */,
/* 31 */,
/* 32 */,
/* 33 */,
/* 34 */,
/* 35 */,
/* 36 */,
/* 37 */,
/* 38 */,
/* 39 */,
/* 40 */,
/* 41 */,
/* 42 */,
/* 43 */,
/* 44 */,
/* 45 */,
/* 46 */,
/* 47 */,
/* 48 */,
/* 49 */,
/* 50 */,
/* 51 */,
/* 52 */,
/* 53 */,
/* 54 */,
/* 55 */,
/* 56 */,
/* 57 */,
/* 58 */,
/* 59 */,
/* 60 */,
/* 61 */,
/* 62 */,
/* 63 */,
/* 64 */,
/* 65 */,
/* 66 */,
/* 67 */,
/* 68 */,
/* 69 */,
/* 70 */,
/* 71 */,
/* 72 */,
/* 73 */,
/* 74 */,
/* 75 */,
/* 76 */,
/* 77 */,
/* 78 */,
/* 79 */,
/* 80 */,
/* 81 */,
/* 82 */,
/* 83 */,
/* 84 */,
/* 85 */,
/* 86 */,
/* 87 */,
/* 88 */,
/* 89 */,
/* 90 */,
/* 91 */,
/* 92 */,
/* 93 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	// Note: Not using more full-fledged query string modules because they are rather large.

	var $ = __webpack_require__(3);


	/**
	 * Borrowed from `qs` module.
	 * @see https://github.com/hapijs/qs/blob/master/lib/utils.js#L68
	 */
	function decode(str) {
		try {
			return decodeURIComponent(str.replace(/\+/g, ' '));
		}
		catch (err) {
			return str;
		}
	}

	/**
	 * Parses the query string in a simplest way.
	 * Only supports non-nested query strings with non-repeating keys.
	 *
	 * @param {string} queryString The query string.
	 * @return {Object} The query params.
	 */
	function parse(queryString) {
		var params = {}, pairs, pair, i, ic;

		// Split into key/value pairs:
		pairs = queryString.split('&');

		// Convert the array of strings into an object:
		for (i = 0, ic = pairs.length; i < ic; i++) {
			pair = pairs[i].split('=');
			params[decode(pair[0])] = decode(pair[1] || '');
		}

		return params;
	}

	/**
	 * Re-uses `jQuery.param` for building query strings.
	 *
	 * @param {Object} params The query params.
	 * @return {string} The query string.
	 */
	function stringify(params) {
		return $.param(params || {});
	}

	/**
	 * Extends the query string of an existing URL.
	 *
	 * @param {string} url The initial URL.
	 * @param {Object} params The params that need ot be updated.
	 * @return {string} The updated URL.
	 */
	function extend(url, params) {
		var index = url.indexOf('?');
		var beforeQueryString = (index < 0 ? url : url.substring(0, index));
		var queryString = (index < 0 ? '' : url.substring(index + 1));
		url = beforeQueryString + '?' + stringify($.extend(parse(queryString), params));
		return url;
	}


	module.exports = {
		parse: parse,
		stringify: stringify,
		extend: extend
	};


/***/ },
/* 94 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(global) {'use strict';

	var _ = __webpack_require__(5);
	var $ = __webpack_require__(3);
	var EventEmitter = __webpack_require__(4);
	var inherits = __webpack_require__(114);
	var assert = __webpack_require__(112);

	var logger = __webpack_require__(99);

	var setTimeout = global.setTimeout;
	var clearTimeout = global.clearTimeout;
	var XMLHttpRequest = global.XMLHttpRequest;


	/**
	 * Receives data on a persistent connection opened via `XMLHttpRequest`.
	 * Emits a 'data' event when some data is received through the persistent connection.
	 * Provides methods to reconnect if required, and maintains reconnect delays.
	 *
	 * @param {string} [options.logPrefix=''] The prefix to add to the log messages.
	 * @param {number} [options.reconnectDelay=2000] The initial reconnect delay.
	 * @param {number} [options.reconnectDelayCoeff=1.1] The multiplier to apply to the delay for the next reconnect.
	 */
	function PersistentConnection(options) {
		EventEmitter.call(this);
		
		var _this = this;
		
		_this._options = _.extend({
			logPrefix: '',
			reconnectDelay: 2000,
			reconnectDelayCoeff: 1.1
		}, options);
		
		_this._url = null;
		
		_this.disconnect();
	}
	inherits(PersistentConnection, EventEmitter);
	_.extend(PersistentConnection.prototype, {
		
		/**
		 * @return {boolean}
		 */
		isConnecting: function () {
			return (!!this._xhr && !this._isConnected);
		},
		
		/**
		 * @return {boolean}
		 */
		isConnected: function () {
			return this._isConnected;
		},
		
		/**
		 * Opens a persistent connection on a given URL.
		 * The server is expected to keep the connection open forever and push the data.
		 *
		 * @param {string} url The URL to request. May be updated later via `setUrl`.
		 */
		connect: function (url) {
			var _this = this;
			
			_this._dropConnection();
			
			_this._url = url;
			
			_this._resetReconnectParams();
			
			_this._establishConnection();
		},
		
		/**
		 * Returns the URL.
		 */
		getUrl: function () {
			return this._url;
		},
		
		/**
		 * Updates the URL for future reconnects.
		 */
		setUrl: function (url) {
			this._url = url;
		},
		
		/**
		 * Disconnects and schedules a reconnect after a delay.
		 * The delay is then increased to have the subsequent reconnects happen less often.
		 */
		reconnect: function () {
			var _this = this;
			
			if (!_this._url) {
				throw new Error('PersistentConnection#reconnect: Missing URL.');
			}
			
			_this._dropConnection();
			
			// Store the previous delay to report it in the event below:
			var reconnectDelay = _this._reconnectDelay;
			
			// Schedule a reconnect:
			_this._reconnectTimer = setTimeout(function () {
				if (_this._isConnected) {
					return;
				}
				
				_this._onReconnecting();
				
				_this._establishConnection();
			}, reconnectDelay);
			
			// Increase the reconnect delay for future reconnects:
			_this._reconnectDelay = Math.ceil(_this._reconnectDelayCoeff * _this._reconnectDelay);
			
			_this._onReconnectScheduled({
				reconnectDelay: reconnectDelay
			});
		},
		
		/**
		 * Drops the current connection.
		 * No-op if not connected.
		 */
		disconnect: function () {
			this._dropConnection();
		},
		
		/**
		 * Drops the current connection and resets the reconnect delay parameters.
		 */
		reset: function () {
			var _this = this;
			
			_this._dropConnection();
			
			_this._resetReconnectParams();
		},
		
		_onConnecting: function () {
			logger.log(this._options.logPrefix + 'Connecting...');
			this.emit('connecting');
		},
		
		_onConnected: function () {
			logger.log(this._options.logPrefix + 'Connected.');
			this.emit('connected');
		},
		
		_onReconnectScheduled: function (args) {
			logger.warn(this._options.logPrefix + 'Will reconnect in ' + args.reconnectDelay + 'ms.');
		},
		
		_onReconnecting: function () {
			logger.warn(this._options.logPrefix + 'Reconnecting...');
		},
		
		_onData: function (data) {
			// logger.log(this._options.logPrefix + 'Data:', data);
			this.emit('data', data);
		},
		
		_onEnd: function () {
			logger.warn(this._options.logPrefix + 'End.');
			this.emit('end');
		},
		
		_onError: function (error) {
			logger.error(this._options.logPrefix + 'Error:', error);
			this.emit('error', error);
		},
		
		_resetReconnectParams: function () {
			var _this = this;
			
			_this._reconnectDelay = _this._options.reconnectDelay;
			_this._reconnectDelayCoeff = _this._options.reconnectDelayCoeff;
		},
		
		_establishConnection: function () {
			var _this = this;
			
			assert(!_this._isConnected);
			
			_this._onConnecting();
			
			var xhr = _this._xhr = new XMLHttpRequest();
			
			var readIndex = 0;
			
			xhr.onload = function (event) {
				_this._dropConnection();
			};
			
			xhr.onabort = xhr.onerror = function (event) {
				_this._dropConnection(new Error());
			};
			
			xhr.onreadystatechange = function () {
				if (xhr.readyState > 2 && xhr.status === 200) {
					if (!_this._isConnected) {
						_this._isConnected = true;
						
						_this._resetReconnectParams();
						
						_this._onConnected();
					}
					
					var responseText = xhr.responseText;
					
					if (readIndex < responseText.length) {
						var data = responseText.substring(readIndex);
						readIndex += data.length;
						
						_this._onData(data);
					}
				}
			};
			
			xhr.open('GET', _this._url, true);
			
			xhr.send(null);
		},
		
		_dropConnection: function (error) {
			var _this = this;
			
			var wasConnected = _this._isConnected;
			
			clearTimeout(_this._reconnectTimer);
			_this._reconnectTimer = null;
			
			var xhr = _this._xhr;
			_this._xhr = null;
			
			if (xhr) {
				// Clear the handlers to prevent memory leaks and
				// prevent the handlers from being called on abort:
				xhr.onload = xhr.onabort = xhr.onerror = xhr.onreadystatechange = null;
				
				// Abort the connection (no-op if not needed):
				xhr.abort();
				
				// Just-in-case nullification:
				xhr = null;
			}
			
			_this._isConnected = false;
			
			if (error) {
				_this._onError(error);
			}
			else if (wasConnected) {
				_this._onEnd();
			}
		}
		
	});

	module.exports = PersistentConnection;
	
	/* WEBPACK VAR INJECTION */}.call(exports, (function() { return this; }())))

/***/ },
/* 95 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var _ = __webpack_require__(5);
	var EventEmitter = __webpack_require__(4);
	var inherits = __webpack_require__(114);

	var ParserBuffer = __webpack_require__(103);

	var logger = __webpack_require__(99);


	// Parser states:
	var S_ERROR = 1;
	var S_JSON = 2;

	// Parser result codes:
	var R_CONTINUE = 1;
	var R_NEED_DATA = 2;
	var R_ERROR = 3;


	/**
	 * Performs parsing of JSON that comes in chunks.
	 * Emits a 'data' event when a JSON object is parsed out.
	 *
	 * @param {string} [options.logPrefix=''] The prefix to add to the log messages.
	 * @param {string} [options.separator=''] The separator between the JSON objects. If non-empty, the parser fails on missing separator.
	 */
	function JsonPerLineParser(options) {
		var _this = this;
		
		_this._options = _.extend({
			logPrefix: ''
		}, options);
		
		_this._buffer = new ParserBuffer();
		
		_this.reset();
	}
	inherits(JsonPerLineParser, EventEmitter);
	_.extend(JsonPerLineParser.prototype, {
		
		/**
		 * Adds data to the parser.
		 * Performs parsing until the data is unparseable.
		 *
		 * @param {string} data The data to add.
		 */
		write: function (data) {
			var _this = this;
			
			_this._buffer.write(data);
			
			_this._parse();
		},
		
		/**
		 * Resets the parser state and buffers.
		 */
		reset: function () {
			var _this = this;
			
			_this._buffer.reset();
			
			_this._state = S_JSON;
		},
		
		_onData: function (jsonObject) {
			//logger.log(this._options.logPrefix + 'Data:', jsonObject);
			this.emit('data', jsonObject);
		},
		
		_onEnd: function () {
			logger.warn(this._options.logPrefix + 'End.');
			this.emit('end');
		},
		
		_onError: function (error) {
			logger.error(this._options.logPrefix + 'Error:', error);
			this.emit('error', error);
		},
		
		_parse: function () {
			var _this = this;
			
			while (true) {
				switch (_this._state) {
				case S_JSON:
					if (_this._parseJson() !== R_CONTINUE) {
						return;
					}
					break;
				default:
					return;
				}
			}
		},
		
		_parseJson: function () {
			var _this = this;
			
			var separator = '\n';
			
			var jsonString = _this._buffer.peekUntil(separator);
			
			if (jsonString === false) {
				return R_NEED_DATA;
			}
			
			var jsonObject;
			try {
				jsonObject = JSON.parse(jsonString);
			}
			catch (ex) {}
			
			if (typeof jsonObject === 'undefined') {
				_this._state = S_ERROR;
				
				_this._onError(new Error('Expected a valid JSON value, got "' +
					_this._buffer.escapeStringForLogging(jsonString) +
					'" near "' +
					_this._buffer.getContextString() +
					'".'
				));
				
				return R_ERROR;
			}
			
			_this._onData(jsonObject);
			
			_this._buffer.advance(jsonString.length + separator.length);
			
			// Expecting JSON:
			_this._state = S_JSON;
			
			return R_CONTINUE;
		}
	});

	module.exports = JsonPerLineParser;


/***/ },
/* 96 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var $ = __webpack_require__(3);
	var _ = __webpack_require__(5);
	var EventEmitter = __webpack_require__(4);
	var inherits = __webpack_require__(114);

	var DashboardLayout = __webpack_require__(104);

	__webpack_require__(105);


	function Dashboard(locator, options) {
		EventEmitter.call(this);
		
		var _this = this;
		
		_this._locator = locator;
		
		_this._options = _.extend({
		}, options);
		
		var $el = _this.$el = $('<div class="knsh-dashboard" />');
	}
	inherits(Dashboard, EventEmitter);
	__webpack_require__(107)(Dashboard.prototype, 'Dashboard');
	_.extend(Dashboard.prototype, {
		componentDidMount: function () {
			var _this = this;
			
			_this._layout = new DashboardLayout(_this._locator, {
			});
			
			_this._layout.mount( _this.$el );
		},
		
		componentWillUnmount: function () {
			var _this = this;
			
			_this._layout.unmount();
		}
	});

	module.exports = Dashboard;


/***/ },
/* 97 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var _ = __webpack_require__(5);
	var EventEmitter = __webpack_require__(4);
	var inherits = __webpack_require__(114);


	function DashboardDataStore(dispatcher, backendApi) {
		EventEmitter.call(this);
		
		var _this = this;
		
		_this._backendApi = backendApi;
		
		/**
		 * Contains metadata for each data stream.
		 * Indexed by dataUrl.
		 */
		_this._meta = {};
		
		/**
		 * Contains cached data samples.
		 * Indexed by dataUrl.
		 */
		_this._data = {};
		
		/**
		 * Contains started streams.
		 * Indexed by dataUrl.
		 */
		_this._streams = {};
		
		dispatcher.on('receive-layout', function () {
			_this._stopAllStreams();
		});
		
		dispatcher.on('receive-meta', function (args) {
			_this._handleMeta(args);
		});
		
		dispatcher.on('receive-data', function (args) {
			_this._handleData(args);
		});
		
		// Silence the 'possible EventEmitter memory leak detected' warning
		// when there are many visualizers (each subscribes to 'data-updated').
		_this.setMaxListeners( 200 );
	}
	inherits(DashboardDataStore, EventEmitter);
	_.extend(DashboardDataStore.prototype, {
		getData: function (dataUrl) {
			return this._data[dataUrl];
		},
		
		_stopAllStreams: function () {
			var _this = this;
			
			_.each(_this._streams, function (stream, dataUrl) {
				_this._streams[dataUrl] = null;
				
				if (stream) {
					stream.stop();
					stream = null;
				}
			});
		},
		
		_handleMeta: function (args) {
			var _this = this,
				meta = args.meta,
				dataUrl = meta.data_url,
				timeInterval = (meta.visualizer_options && meta.visualizer_options.time_interval);
			
			// WARNING: The frontend assumes unique data URLs.
			
			// Update the meta cache:
			_this._meta[dataUrl] = meta;
			
			// Create the data array if required:
			_this._data[dataUrl] = _this._data[dataUrl] || [];
			
			// Start a data stream if not yet started:
			if (!_this._streams[dataUrl]) {
				_this._streams[dataUrl] = _this._backendApi.streamData(dataUrl, timeInterval);
			}
			
			// Notify that the new data set has appeared: 
			_this.emit('data-updated', {
				dataUrl: dataUrl
			});
		},
		
		_handleData: function (args) {
			var _this = this,
				dataUrl = args.dataUrl,
				data = args.data,
				meta = _this._meta[dataUrl],
				timeInterval = (meta.visualizer_options && meta.visualizer_options.time_interval);
			
			// WARNING: The frontend assumes unique data URLs.
			
			// Create the data array if required:
			var seriesData = _this._data[dataUrl] = _this._data[dataUrl] || [];
			
			// Add new data:
			if (args.replace) {
				seriesData.splice.apply(seriesData, [ 0, seriesData.length ].concat(data));
			}
			else {
				seriesData.push.apply(seriesData, data);
			}
			
			// Truncate old data:
			if (typeof timeInterval === 'number') {
				var shiftIndex = 0;
				while ( (seriesData[seriesData.length-1].x - seriesData[shiftIndex].x) > (1.5 * timeInterval) ) {
					++shiftIndex;
				}
				if (shiftIndex > 0) {
					seriesData.splice(0, shiftIndex);
				}
			}
			
			// Notify the data has updated:
			_this.emit('data-updated', {
				dataUrl: dataUrl
			});
		}
	});

	module.exports = DashboardDataStore;


/***/ },
/* 98 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var $ = __webpack_require__(3);
	var _ = __webpack_require__(5);
	var EventEmitter = __webpack_require__(4);
	var inherits = __webpack_require__(114);


	function DashboardLayoutStore(dispatcher, backendApi) {
		EventEmitter.call(this);
		
		var _this = this;
		
		_this._backendApi = backendApi;
		
		/**
		 * Contains the current layout.
		 */
		_this._layout = {};
		
		/**
		 * Contains metadata for each layout cell.
		 * Indexed by metaUrl.
		 */
		_this._meta = {};
		
		dispatcher.on('receive-layout', function (args) {
			_this._handleLayout(args);
		});
		
		dispatcher.on('receive-meta', function (args) {
			_this._handleMeta(args);
		});
		
		dispatcher.on('resize-window', function () {
			_this.emit('layout-resized');
		});
		
		// Silence the 'possible EventEmitter memory leak detected' warning
		// when there are many visualizers (each subscribes to 'layout-resized').
		_this.setMaxListeners( 200 );
	}
	inherits(DashboardLayoutStore, EventEmitter);
	_.extend(DashboardLayoutStore.prototype, {
		getLayout: function () {
			return this._layout;
		},
		
		getMeta: function (metaUrl) {
			return this._meta[metaUrl];
		},
		
		traverseLayout: function (layout, ctx, beforeFn, itemFn, afterFn) {
			var _this = this,
				items = layout.row || layout.col || [];
			
			if (beforeFn) { beforeFn.call(_this, ctx, layout); }
			
			_.each(items, function (item) {
				if (itemFn) { itemFn.call(_this, ctx, layout, item, item.cell); }
				
				if (item.row || item.col) {
					_this.traverseLayout(item, ctx, beforeFn, itemFn, afterFn);
				}
			});
			
			if (afterFn) { afterFn.call(_this, ctx, layout); }
		},
		
		_handleLayout: function (args) {
			var _this = this;
			
			_this._layout = args.layout || {};
			
			_this.traverseLayout(_this._layout, {},
				null,
				function (ctx, layout, item, cell) {
					if (cell && cell.meta_url) {
						_this._backendApi.loadMeta(cell.meta_url);
					}
				},
				null
			);
			
			_this.emit('layout-changed');
		},
		
		_handleMeta: function (args) {
			var _this = this;
			
			_this._meta[args.metaUrl] = args.meta;
			
			_this.emit('meta-changed', {
				metaUrl: args.metaUrl
			});
		}
	});

	module.exports = DashboardLayoutStore;


/***/ },
/* 99 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(process) {'use strict';

	// Use 'loglevel' module for its simplicity and
	// small size compared to the full-featured 'winston'.
	var logger = __webpack_require__(115);

	if (process.env.NODE_ENV === "production") {
		logger.setLevel(logger.levels.ERROR);
	}

	// Exports 'trace', 'debug', 'info', 'log', 'warn', 'error' methods.
	// Other methods like 'setLevel', 'enableAll', 'disableAll' should
	// not be used from the outer code.
	module.exports = logger;
	
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(113)))

/***/ },
/* 100 */
/***/ function(module, exports, __webpack_require__) {

	// Copyright Joyent, Inc. and other Node contributors.
	//
	// Permission is hereby granted, free of charge, to any person obtaining a
	// copy of this software and associated documentation files (the
	// "Software"), to deal in the Software without restriction, including
	// without limitation the rights to use, copy, modify, merge, publish,
	// distribute, sublicense, and/or sell copies of the Software, and to permit
	// persons to whom the Software is furnished to do so, subject to the
	// following conditions:
	//
	// The above copyright notice and this permission notice shall be included
	// in all copies or substantial portions of the Software.
	//
	// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
	// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
	// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
	// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
	// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
	// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
	// USE OR OTHER DEALINGS IN THE SOFTWARE.

	var punycode = __webpack_require__(108);

	exports.parse = urlParse;
	exports.resolve = urlResolve;
	exports.resolveObject = urlResolveObject;
	exports.format = urlFormat;

	exports.Url = Url;

	function Url() {
	  this.protocol = null;
	  this.slashes = null;
	  this.auth = null;
	  this.host = null;
	  this.port = null;
	  this.hostname = null;
	  this.hash = null;
	  this.search = null;
	  this.query = null;
	  this.pathname = null;
	  this.path = null;
	  this.href = null;
	}

	// Reference: RFC 3986, RFC 1808, RFC 2396

	// define these here so at least they only have to be
	// compiled once on the first module load.
	var protocolPattern = /^([a-z0-9.+-]+:)/i,
	    portPattern = /:[0-9]*$/,

	    // RFC 2396: characters reserved for delimiting URLs.
	    // We actually just auto-escape these.
	    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

	    // RFC 2396: characters not allowed for various reasons.
	    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

	    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
	    autoEscape = ['\''].concat(unwise),
	    // Characters that are never ever allowed in a hostname.
	    // Note that any invalid chars are also handled, but these
	    // are the ones that are *expected* to be seen, so we fast-path
	    // them.
	    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
	    hostEndingChars = ['/', '?', '#'],
	    hostnameMaxLen = 255,
	    hostnamePartPattern = /^[a-z0-9A-Z_-]{0,63}$/,
	    hostnamePartStart = /^([a-z0-9A-Z_-]{0,63})(.*)$/,
	    // protocols that can allow "unsafe" and "unwise" chars.
	    unsafeProtocol = {
	      'javascript': true,
	      'javascript:': true
	    },
	    // protocols that never have a hostname.
	    hostlessProtocol = {
	      'javascript': true,
	      'javascript:': true
	    },
	    // protocols that always contain a // bit.
	    slashedProtocol = {
	      'http': true,
	      'https': true,
	      'ftp': true,
	      'gopher': true,
	      'file': true,
	      'http:': true,
	      'https:': true,
	      'ftp:': true,
	      'gopher:': true,
	      'file:': true
	    },
	    querystring = __webpack_require__(109);

	function urlParse(url, parseQueryString, slashesDenoteHost) {
	  if (url && isObject(url) && url instanceof Url) return url;

	  var u = new Url;
	  u.parse(url, parseQueryString, slashesDenoteHost);
	  return u;
	}

	Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
	  if (!isString(url)) {
	    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
	  }

	  var rest = url;

	  // trim before proceeding.
	  // This is to support parse stuff like "  http://foo.com  \n"
	  rest = rest.trim();

	  var proto = protocolPattern.exec(rest);
	  if (proto) {
	    proto = proto[0];
	    var lowerProto = proto.toLowerCase();
	    this.protocol = lowerProto;
	    rest = rest.substr(proto.length);
	  }

	  // figure out if it's got a host
	  // user@server is *always* interpreted as a hostname, and url
	  // resolution will treat //foo/bar as host=foo,path=bar because that's
	  // how the browser resolves relative URLs.
	  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
	    var slashes = rest.substr(0, 2) === '//';
	    if (slashes && !(proto && hostlessProtocol[proto])) {
	      rest = rest.substr(2);
	      this.slashes = true;
	    }
	  }

	  if (!hostlessProtocol[proto] &&
	      (slashes || (proto && !slashedProtocol[proto]))) {

	    // there's a hostname.
	    // the first instance of /, ?, ;, or # ends the host.
	    //
	    // If there is an @ in the hostname, then non-host chars *are* allowed
	    // to the left of the last @ sign, unless some host-ending character
	    // comes *before* the @-sign.
	    // URLs are obnoxious.
	    //
	    // ex:
	    // http://a@b@c/ => user:a@b host:c
	    // http://a@b?@c => user:a host:c path:/?@c

	    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
	    // Review our test case against browsers more comprehensively.

	    // find the first instance of any hostEndingChars
	    var hostEnd = -1;
	    for (var i = 0; i < hostEndingChars.length; i++) {
	      var hec = rest.indexOf(hostEndingChars[i]);
	      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
	        hostEnd = hec;
	    }

	    // at this point, either we have an explicit point where the
	    // auth portion cannot go past, or the last @ char is the decider.
	    var auth, atSign;
	    if (hostEnd === -1) {
	      // atSign can be anywhere.
	      atSign = rest.lastIndexOf('@');
	    } else {
	      // atSign must be in auth portion.
	      // http://a@b/c@d => host:b auth:a path:/c@d
	      atSign = rest.lastIndexOf('@', hostEnd);
	    }

	    // Now we have a portion which is definitely the auth.
	    // Pull that off.
	    if (atSign !== -1) {
	      auth = rest.slice(0, atSign);
	      rest = rest.slice(atSign + 1);
	      this.auth = decodeURIComponent(auth);
	    }

	    // the host is the remaining to the left of the first non-host char
	    hostEnd = -1;
	    for (var i = 0; i < nonHostChars.length; i++) {
	      var hec = rest.indexOf(nonHostChars[i]);
	      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
	        hostEnd = hec;
	    }
	    // if we still have not hit it, then the entire thing is a host.
	    if (hostEnd === -1)
	      hostEnd = rest.length;

	    this.host = rest.slice(0, hostEnd);
	    rest = rest.slice(hostEnd);

	    // pull out port.
	    this.parseHost();

	    // we've indicated that there is a hostname,
	    // so even if it's empty, it has to be present.
	    this.hostname = this.hostname || '';

	    // if hostname begins with [ and ends with ]
	    // assume that it's an IPv6 address.
	    var ipv6Hostname = this.hostname[0] === '[' &&
	        this.hostname[this.hostname.length - 1] === ']';

	    // validate a little.
	    if (!ipv6Hostname) {
	      var hostparts = this.hostname.split(/\./);
	      for (var i = 0, l = hostparts.length; i < l; i++) {
	        var part = hostparts[i];
	        if (!part) continue;
	        if (!part.match(hostnamePartPattern)) {
	          var newpart = '';
	          for (var j = 0, k = part.length; j < k; j++) {
	            if (part.charCodeAt(j) > 127) {
	              // we replace non-ASCII char with a temporary placeholder
	              // we need this to make sure size of hostname is not
	              // broken by replacing non-ASCII by nothing
	              newpart += 'x';
	            } else {
	              newpart += part[j];
	            }
	          }
	          // we test again with ASCII char only
	          if (!newpart.match(hostnamePartPattern)) {
	            var validParts = hostparts.slice(0, i);
	            var notHost = hostparts.slice(i + 1);
	            var bit = part.match(hostnamePartStart);
	            if (bit) {
	              validParts.push(bit[1]);
	              notHost.unshift(bit[2]);
	            }
	            if (notHost.length) {
	              rest = '/' + notHost.join('.') + rest;
	            }
	            this.hostname = validParts.join('.');
	            break;
	          }
	        }
	      }
	    }

	    if (this.hostname.length > hostnameMaxLen) {
	      this.hostname = '';
	    } else {
	      // hostnames are always lower case.
	      this.hostname = this.hostname.toLowerCase();
	    }

	    if (!ipv6Hostname) {
	      // IDNA Support: Returns a puny coded representation of "domain".
	      // It only converts the part of the domain name that
	      // has non ASCII characters. I.e. it dosent matter if
	      // you call it with a domain that already is in ASCII.
	      var domainArray = this.hostname.split('.');
	      var newOut = [];
	      for (var i = 0; i < domainArray.length; ++i) {
	        var s = domainArray[i];
	        newOut.push(s.match(/[^A-Za-z0-9_-]/) ?
	            'xn--' + punycode.encode(s) : s);
	      }
	      this.hostname = newOut.join('.');
	    }

	    var p = this.port ? ':' + this.port : '';
	    var h = this.hostname || '';
	    this.host = h + p;
	    this.href += this.host;

	    // strip [ and ] from the hostname
	    // the host field still retains them, though
	    if (ipv6Hostname) {
	      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
	      if (rest[0] !== '/') {
	        rest = '/' + rest;
	      }
	    }
	  }

	  // now rest is set to the post-host stuff.
	  // chop off any delim chars.
	  if (!unsafeProtocol[lowerProto]) {

	    // First, make 100% sure that any "autoEscape" chars get
	    // escaped, even if encodeURIComponent doesn't think they
	    // need to be.
	    for (var i = 0, l = autoEscape.length; i < l; i++) {
	      var ae = autoEscape[i];
	      var esc = encodeURIComponent(ae);
	      if (esc === ae) {
	        esc = escape(ae);
	      }
	      rest = rest.split(ae).join(esc);
	    }
	  }


	  // chop off from the tail first.
	  var hash = rest.indexOf('#');
	  if (hash !== -1) {
	    // got a fragment string.
	    this.hash = rest.substr(hash);
	    rest = rest.slice(0, hash);
	  }
	  var qm = rest.indexOf('?');
	  if (qm !== -1) {
	    this.search = rest.substr(qm);
	    this.query = rest.substr(qm + 1);
	    if (parseQueryString) {
	      this.query = querystring.parse(this.query);
	    }
	    rest = rest.slice(0, qm);
	  } else if (parseQueryString) {
	    // no query string, but parseQueryString still requested
	    this.search = '';
	    this.query = {};
	  }
	  if (rest) this.pathname = rest;
	  if (slashedProtocol[lowerProto] &&
	      this.hostname && !this.pathname) {
	    this.pathname = '/';
	  }

	  //to support http.request
	  if (this.pathname || this.search) {
	    var p = this.pathname || '';
	    var s = this.search || '';
	    this.path = p + s;
	  }

	  // finally, reconstruct the href based on what has been validated.
	  this.href = this.format();
	  return this;
	};

	// format a parsed object into a url string
	function urlFormat(obj) {
	  // ensure it's an object, and not a string url.
	  // If it's an obj, this is a no-op.
	  // this way, you can call url_format() on strings
	  // to clean up potentially wonky urls.
	  if (isString(obj)) obj = urlParse(obj);
	  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
	  return obj.format();
	}

	Url.prototype.format = function() {
	  var auth = this.auth || '';
	  if (auth) {
	    auth = encodeURIComponent(auth);
	    auth = auth.replace(/%3A/i, ':');
	    auth += '@';
	  }

	  var protocol = this.protocol || '',
	      pathname = this.pathname || '',
	      hash = this.hash || '',
	      host = false,
	      query = '';

	  if (this.host) {
	    host = auth + this.host;
	  } else if (this.hostname) {
	    host = auth + (this.hostname.indexOf(':') === -1 ?
	        this.hostname :
	        '[' + this.hostname + ']');
	    if (this.port) {
	      host += ':' + this.port;
	    }
	  }

	  if (this.query &&
	      isObject(this.query) &&
	      Object.keys(this.query).length) {
	    query = querystring.stringify(this.query);
	  }

	  var search = this.search || (query && ('?' + query)) || '';

	  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

	  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
	  // unless they had them to begin with.
	  if (this.slashes ||
	      (!protocol || slashedProtocol[protocol]) && host !== false) {
	    host = '//' + (host || '');
	    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
	  } else if (!host) {
	    host = '';
	  }

	  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
	  if (search && search.charAt(0) !== '?') search = '?' + search;

	  pathname = pathname.replace(/[?#]/g, function(match) {
	    return encodeURIComponent(match);
	  });
	  search = search.replace('#', '%23');

	  return protocol + host + pathname + search + hash;
	};

	function urlResolve(source, relative) {
	  return urlParse(source, false, true).resolve(relative);
	}

	Url.prototype.resolve = function(relative) {
	  return this.resolveObject(urlParse(relative, false, true)).format();
	};

	function urlResolveObject(source, relative) {
	  if (!source) return relative;
	  return urlParse(source, false, true).resolveObject(relative);
	}

	Url.prototype.resolveObject = function(relative) {
	  if (isString(relative)) {
	    var rel = new Url();
	    rel.parse(relative, false, true);
	    relative = rel;
	  }

	  var result = new Url();
	  Object.keys(this).forEach(function(k) {
	    result[k] = this[k];
	  }, this);

	  // hash is always overridden, no matter what.
	  // even href="" will remove it.
	  result.hash = relative.hash;

	  // if the relative url is empty, then there's nothing left to do here.
	  if (relative.href === '') {
	    result.href = result.format();
	    return result;
	  }

	  // hrefs like //foo/bar always cut to the protocol.
	  if (relative.slashes && !relative.protocol) {
	    // take everything except the protocol from relative
	    Object.keys(relative).forEach(function(k) {
	      if (k !== 'protocol')
	        result[k] = relative[k];
	    });

	    //urlParse appends trailing / to urls like http://www.example.com
	    if (slashedProtocol[result.protocol] &&
	        result.hostname && !result.pathname) {
	      result.path = result.pathname = '/';
	    }

	    result.href = result.format();
	    return result;
	  }

	  if (relative.protocol && relative.protocol !== result.protocol) {
	    // if it's a known url protocol, then changing
	    // the protocol does weird things
	    // first, if it's not file:, then we MUST have a host,
	    // and if there was a path
	    // to begin with, then we MUST have a path.
	    // if it is file:, then the host is dropped,
	    // because that's known to be hostless.
	    // anything else is assumed to be absolute.
	    if (!slashedProtocol[relative.protocol]) {
	      Object.keys(relative).forEach(function(k) {
	        result[k] = relative[k];
	      });
	      result.href = result.format();
	      return result;
	    }

	    result.protocol = relative.protocol;
	    if (!relative.host && !hostlessProtocol[relative.protocol]) {
	      var relPath = (relative.pathname || '').split('/');
	      while (relPath.length && !(relative.host = relPath.shift()));
	      if (!relative.host) relative.host = '';
	      if (!relative.hostname) relative.hostname = '';
	      if (relPath[0] !== '') relPath.unshift('');
	      if (relPath.length < 2) relPath.unshift('');
	      result.pathname = relPath.join('/');
	    } else {
	      result.pathname = relative.pathname;
	    }
	    result.search = relative.search;
	    result.query = relative.query;
	    result.host = relative.host || '';
	    result.auth = relative.auth;
	    result.hostname = relative.hostname || relative.host;
	    result.port = relative.port;
	    // to support http.request
	    if (result.pathname || result.search) {
	      var p = result.pathname || '';
	      var s = result.search || '';
	      result.path = p + s;
	    }
	    result.slashes = result.slashes || relative.slashes;
	    result.href = result.format();
	    return result;
	  }

	  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
	      isRelAbs = (
	          relative.host ||
	          relative.pathname && relative.pathname.charAt(0) === '/'
	      ),
	      mustEndAbs = (isRelAbs || isSourceAbs ||
	                    (result.host && relative.pathname)),
	      removeAllDots = mustEndAbs,
	      srcPath = result.pathname && result.pathname.split('/') || [],
	      relPath = relative.pathname && relative.pathname.split('/') || [],
	      psychotic = result.protocol && !slashedProtocol[result.protocol];

	  // if the url is a non-slashed url, then relative
	  // links like ../.. should be able
	  // to crawl up to the hostname, as well.  This is strange.
	  // result.protocol has already been set by now.
	  // Later on, put the first path part into the host field.
	  if (psychotic) {
	    result.hostname = '';
	    result.port = null;
	    if (result.host) {
	      if (srcPath[0] === '') srcPath[0] = result.host;
	      else srcPath.unshift(result.host);
	    }
	    result.host = '';
	    if (relative.protocol) {
	      relative.hostname = null;
	      relative.port = null;
	      if (relative.host) {
	        if (relPath[0] === '') relPath[0] = relative.host;
	        else relPath.unshift(relative.host);
	      }
	      relative.host = null;
	    }
	    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
	  }

	  if (isRelAbs) {
	    // it's absolute.
	    result.host = (relative.host || relative.host === '') ?
	                  relative.host : result.host;
	    result.hostname = (relative.hostname || relative.hostname === '') ?
	                      relative.hostname : result.hostname;
	    result.search = relative.search;
	    result.query = relative.query;
	    srcPath = relPath;
	    // fall through to the dot-handling below.
	  } else if (relPath.length) {
	    // it's relative
	    // throw away the existing file, and take the new path instead.
	    if (!srcPath) srcPath = [];
	    srcPath.pop();
	    srcPath = srcPath.concat(relPath);
	    result.search = relative.search;
	    result.query = relative.query;
	  } else if (!isNullOrUndefined(relative.search)) {
	    // just pull out the search.
	    // like href='?foo'.
	    // Put this after the other two cases because it simplifies the booleans
	    if (psychotic) {
	      result.hostname = result.host = srcPath.shift();
	      //occationaly the auth can get stuck only in host
	      //this especialy happens in cases like
	      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
	      var authInHost = result.host && result.host.indexOf('@') > 0 ?
	                       result.host.split('@') : false;
	      if (authInHost) {
	        result.auth = authInHost.shift();
	        result.host = result.hostname = authInHost.shift();
	      }
	    }
	    result.search = relative.search;
	    result.query = relative.query;
	    //to support http.request
	    if (!isNull(result.pathname) || !isNull(result.search)) {
	      result.path = (result.pathname ? result.pathname : '') +
	                    (result.search ? result.search : '');
	    }
	    result.href = result.format();
	    return result;
	  }

	  if (!srcPath.length) {
	    // no path at all.  easy.
	    // we've already handled the other stuff above.
	    result.pathname = null;
	    //to support http.request
	    if (result.search) {
	      result.path = '/' + result.search;
	    } else {
	      result.path = null;
	    }
	    result.href = result.format();
	    return result;
	  }

	  // if a url ENDs in . or .., then it must get a trailing slash.
	  // however, if it ends in anything else non-slashy,
	  // then it must NOT get a trailing slash.
	  var last = srcPath.slice(-1)[0];
	  var hasTrailingSlash = (
	      (result.host || relative.host) && (last === '.' || last === '..') ||
	      last === '');

	  // strip single dots, resolve double dots to parent dir
	  // if the path tries to go above the root, `up` ends up > 0
	  var up = 0;
	  for (var i = srcPath.length; i >= 0; i--) {
	    last = srcPath[i];
	    if (last == '.') {
	      srcPath.splice(i, 1);
	    } else if (last === '..') {
	      srcPath.splice(i, 1);
	      up++;
	    } else if (up) {
	      srcPath.splice(i, 1);
	      up--;
	    }
	  }

	  // if the path is allowed to go above the root, restore leading ..s
	  if (!mustEndAbs && !removeAllDots) {
	    for (; up--; up) {
	      srcPath.unshift('..');
	    }
	  }

	  if (mustEndAbs && srcPath[0] !== '' &&
	      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
	    srcPath.unshift('');
	  }

	  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
	    srcPath.push('');
	  }

	  var isAbsolute = srcPath[0] === '' ||
	      (srcPath[0] && srcPath[0].charAt(0) === '/');

	  // put the host back
	  if (psychotic) {
	    result.hostname = result.host = isAbsolute ? '' :
	                                    srcPath.length ? srcPath.shift() : '';
	    //occationaly the auth can get stuck only in host
	    //this especialy happens in cases like
	    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
	    var authInHost = result.host && result.host.indexOf('@') > 0 ?
	                     result.host.split('@') : false;
	    if (authInHost) {
	      result.auth = authInHost.shift();
	      result.host = result.hostname = authInHost.shift();
	    }
	  }

	  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

	  if (mustEndAbs && !isAbsolute) {
	    srcPath.unshift('');
	  }

	  if (!srcPath.length) {
	    result.pathname = null;
	    result.path = null;
	  } else {
	    result.pathname = srcPath.join('/');
	  }

	  //to support request.http
	  if (!isNull(result.pathname) || !isNull(result.search)) {
	    result.path = (result.pathname ? result.pathname : '') +
	                  (result.search ? result.search : '');
	  }
	  result.auth = relative.auth || result.auth;
	  result.slashes = result.slashes || relative.slashes;
	  result.href = result.format();
	  return result;
	};

	Url.prototype.parseHost = function() {
	  var host = this.host;
	  var port = portPattern.exec(host);
	  if (port) {
	    port = port[0];
	    if (port !== ':') {
	      this.port = port.substr(1);
	    }
	    host = host.substr(0, host.length - port.length);
	  }
	  if (host) this.hostname = host;
	};

	function isString(arg) {
	  return typeof arg === "string";
	}

	function isObject(arg) {
	  return typeof arg === 'object' && arg !== null;
	}

	function isNull(arg) {
	  return arg === null;
	}
	function isNullOrUndefined(arg) {
	  return  arg == null;
	}


/***/ },
/* 101 */
/***/ function(module, exports, __webpack_require__) {

	// style-loader: Adds some css to the DOM by adding a <style> tag

	// load the styles
	var content = __webpack_require__(102);
	if(typeof content === 'string') content = [[module.id, content, '']];
	// add the styles to the DOM
	var update = __webpack_require__(9)(content, {});
	// Hot Module Replacement
	if(false) {
		// When the styles change, update the <style> tags
		module.hot.accept("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/index.less", function() {
			var newContent = require("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/index.less");
			if(typeof newContent === 'string') newContent = [[module.id, newContent, '']];
			update(newContent);
		});
		// When the module is disposed, remove the <style> tags
		module.hot.dispose(function() { update(); });
	}

/***/ },
/* 102 */
/***/ function(module, exports, __webpack_require__) {

	exports = module.exports = __webpack_require__(11)();
	exports.push([module.id, "html,\nbody {\n  margin: 0;\n  padding: 0;\n  height: 100%;\n}\n", ""]);

/***/ },
/* 103 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var _ = __webpack_require__(5);


	/**
	 * Provides low-level utility to manage a buffer for a stream string parser.
	 * Shifts the buffer when the specified amount of characters has been
	 * consumed via `advance`.
	 *
	 * @param {number} [options.bufferShiftLength=2048] The number of characters to keep in the buffer until next shift.
	 */
	function ParserBuffer(options) {
		var _this = this;
		
		_this._options = _.extend({
			bufferShiftLength: 2048
		}, options);
		
		_this.reset();
	}
	_.extend(ParserBuffer.prototype, {
		
		/**
		 * Adds data to the buffer.
		 *
		 * @param {string} data The data to add.
		 */
		write: function (data) {
			var _this = this;
			
			_this._buffer += data;
		},
		
		/**
		 * Resets the buffer.
		 */
		reset: function () {
			var _this = this;
			
			_this._buffer = '';
			_this._readIndex = 0;
			_this._advanceLength = 0;
		},
		
		/**
		 * Returns the number of string characters that has been consumed
		 * via `advance` since last reset or instantiation.
		 *
		 * @return {number} The number of string characters consumed.
		 */
		getConsumedLength: function () {
			var _this = this;
			
			return (_this._readIndex + _this._advanceLength);
		},
		
		/**
		 * Returns the number of string characters that remains in the buffer.
		 *
		 * @return {number} The number of string characters remaining.
		 */
		getRemainingLength: function () {
			var _this = this;
			
			return (_this._buffer.length - _this._readIndex);
		},
		
		/**
		 * Returns the part of the buffer till the first occurrence of the delimiter.
		 * If the delimiter is not found in the buffer, returns `false`.
		 *
		 * @return {string|boolean}
		 */
		peekUntil: function (delimiter) {
			var _this = this;
			
			var startIndex = _this._readIndex;
			var endIndex = (delimiter
				? _this._buffer.indexOf(delimiter, startIndex)
				: _this._buffer.length - 1
			);
			
			if (endIndex < 0) {
				return false;
			}
			
			var data = _this.peek(endIndex - startIndex);
			
			return data;
		},
		
		/**
		 * Returns the specified number of string characters from the buffer.
		 * May skip some characters from the buffer start if required.
		 * If there is not enough characters in the buffer, returns `false`.
		 *
		 * @param {number} length The number of string characters to return.
		 * @param {number} [skip=0] The number of string characters to skip from the buffer start.
		 *
		 * @return {string|boolean}
		 */
		peek: function (length, skip) {
			var _this = this;
			
			if (typeof skip === 'undefined' || skip < 0) {
				skip = 0;
			}
			
			var startIndex = (_this._readIndex + skip);
			var endIndex = (startIndex + length);
			
			// The end index may reach the buffer length to read to the buffer end:
			if (endIndex < startIndex || endIndex > _this._buffer.length) {
				return false;
			}
			
			var data = _this._buffer.substring(startIndex, endIndex);
			
			return data;
		},
		
		/**
		 * Moves the internal pointer of the buffer forward
		 * by the specified number of string characters.
		 *
		 * @param {number} length The number of string characters to advance by.
		 *
		 * @return {boolean} `true` on success; `false` if there is not enough characters in the buffer.
		 */
		advance: function (length) {
			var _this = this;
			
			// The read index may reach the buffer length, 
			// this would indicate there is no more characters to read:
			if ((_this._readIndex + length) > _this._buffer.length) {
				return false;
			}
			
			_this._readIndex += length;
			
			// Shift the buffer so the consumed part does not occupy memory:
			var bufferShiftLength = _this._options.bufferShiftLength;
			if (bufferShiftLength > 0 && _this._readIndex >= bufferShiftLength) {
				_this._buffer = _this._buffer.substring(bufferShiftLength);
				_this._readIndex -= bufferShiftLength;
				_this._advanceLength += bufferShiftLength;
			}
			
			return true;
		},
		
		/**
		 * Returns a string describing the current buffer state.
		 * Useful for error or log messages.
		 * 
		 * @return {string}
		 */
		getContextString: function () {
			var _this = this;
			
			var ret = '';
			
			if (_this.getConsumedLength() > 0) {
				ret += '...';
			}
			
			var contextLength = 10;
			var context = _this.peek(Math.min(_this.getRemainingLength(), contextLength));
			
			if (context.length > 0) {
				ret += _this.escapeStringForLogging(context);
			}
			
			if ((_this.getRemainingLength() - context.length) > 0) {
				ret += '...';
			}
			else {
				ret += '<EOF>';
			}
			
			return ret;
		},
		
		/**
		 * Escapes the control characters in the given data string.
		 * Useful for error or log messages.
		 * 
		 * @param {string} data The data to process.
		 *
		 * @return {string}
		 */
		escapeStringForLogging: function (data) {
			// HACK: Quick & dirty way to escape special chars:
			return (
				JSON.stringify(String(data))
					.replace(/^"|"$/g, '')
					.replace(/\\"/g, '"')
			);
		}
	});

	module.exports = ParserBuffer;


/***/ },
/* 104 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var $ = __webpack_require__(3);
	var _ = __webpack_require__(5);

	__webpack_require__(118);


	function DashboardLayout(locator, options) {
		var _this = this;
		
		_this._locator = locator;
		
		_this._layoutStore = _this._locator.getLayoutStore();
		
		_this._options = _.extend({
		}, options);
		
		_this._layout = {};
		
		_this.$el = $('<div class="knsh-dashboard-layout"></div>');
	}
	__webpack_require__(107)(DashboardLayout.prototype, 'DashboardLayout');
	_.extend(DashboardLayout.prototype, {
		componentDidMount: function () {
			var _this = this;
			
			_this._renderLayout();
			
			_this._layoutStore.on('layout-changed', function () {
				_this._renderLayout();
			});
			
			_this._layoutStore.on('meta-changed', function (args) {
				_this._handleMeta(args);
			});
		},
		
		componentWillUnmount: function () {
			var _this = this;
			
			_this._destroyLayout();
		},
		
		_traverseLayout: function (layout, ctx, beforeFn, itemFn, afterFn) {
			this._layoutStore.traverseLayout(layout, ctx, beforeFn, itemFn, afterFn);
		},
		
		_destroyLayout: function () {
			var _this = this;
			
			if (!_this._layout) { return; }
			
			_this._traverseLayout(_this._layout, {},
				null,
				function (ctx, layout, item, cell) {
					if (cell && cell.visualizer) {
						if (cell.visualizer.unmount) {
							cell.visualizer.unmount();
						}
						cell.visualizer = null;
					}
				},
				null
			);
			
			_this._layout = {};
			
			_this.$el.empty();
		},
		
		_renderLayout: function () {
			var _this = this;
			
			_this._destroyLayout();
			
			_this._layout = $.extend(true, {}, _this._layoutStore.getLayout());
			
			_this._layout.$root = _this.$el;
			
			_this._traverseLayout(_this._layout, {},
				function (ctx, layout) {
					var $layout = layout.$layout = $('<div class="knsh-dashboard-layout-group ' +
						__webpack_require__(120)(layout.css_classes) + '"></div>');
					
					if (layout.row) {
						$layout.addClass('knsh-dashboard-layout-group__m-row');
					}
					else {
						$layout.addClass('knsh-dashboard-layout-group__m-col');
					}
					
					var $items = layout.$items = $('<div class="knsh-dashboard-layout-group__items"></div>');
					
					$layout.appendTo(layout.$root);
					$items.appendTo($layout);
				},
				function (ctx, layout, item, cell) {
					var $item = item.$root = $('<div class="knsh-dashboard-layout-group__item"></div>');
					
					$item.appendTo(layout.$items);
					
					if (cell) {
						var $card = cell.$card = $('<div class="knsh-dashboard-layout-card ' +
							__webpack_require__(120)(cell.css_classes) + '"></div>');
						
						$card.appendTo($item);
					}
				},
				null
			);
		},
		
		_handleMeta: function (args) {
			var _this = this,
				metaUrl = args.metaUrl;
			
			_this._traverseLayout(_this._layout, {},
				null,
				function (ctx, layout, item, cell) {
					if (cell && cell.meta_url === metaUrl) {
						var meta = _this._layoutStore.getMeta(metaUrl);
						
						if (!cell.visualizer && meta.visualizer_name) {
							var Visualizer = __webpack_require__(121)("./" + meta.visualizer_name);
							
							// WARNING: The visualizers must take dimensions from the layout
							// and not stretch it, otherwise the sizes may get out of sync.
							cell.visualizer = new Visualizer(
								_this._locator,
								meta.visualizer_options,
								meta.data_url
							);
							
							if (cell.visualizer.mount) {
								cell.visualizer.mount( cell.$card );
							}
						}
						
						// TODO: Update visualizer options from meta.
					}
				},
				null
			);
		}
	});

	module.exports = DashboardLayout;


/***/ },
/* 105 */
/***/ function(module, exports, __webpack_require__) {

	// style-loader: Adds some css to the DOM by adding a <style> tag

	// load the styles
	var content = __webpack_require__(106);
	if(typeof content === 'string') content = [[module.id, content, '']];
	// add the styles to the DOM
	var update = __webpack_require__(9)(content, {});
	// Hot Module Replacement
	if(false) {
		// When the styles change, update the <style> tags
		module.hot.accept("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/dashboard.less", function() {
			var newContent = require("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/dashboard.less");
			if(typeof newContent === 'string') newContent = [[module.id, newContent, '']];
			update(newContent);
		});
		// When the module is disposed, remove the <style> tags
		module.hot.dispose(function() { update(); });
	}

/***/ },
/* 106 */
/***/ function(module, exports, __webpack_require__) {

	exports = module.exports = __webpack_require__(11)();
	exports.push([module.id, ".knsh-dashboard {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n}\n", ""]);

/***/ },
/* 107 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var _ = __webpack_require__(5);

	module.exports = function (proto, classname) {
		_.extend(proto, {
			mount: function (container) {
				var _this = this;
				
				if (_this._mounted) {
					throw new Error(classname + '#mount: Already mounted.');
				}
				
				_this._mounted = true;
				
				if (_this.$el) {
					_this.$el.appendTo(container);
				}
				
				if (_this.componentDidMount) {
					_this.componentDidMount();
				}
			},
			
			unmount: function () {
				var _this = this;
				
				if (!_this._mounted) {
					throw new Error(classname + '#unmount: Not mounted.');
				}
				
				if (_this.componentWillUnmount) {
					_this.componentWillUnmount();
				}
				
				if (_this.$el) {
					_this.$el.detach();
				}
				
				_this._mounted = false;
			}
		});
	};


/***/ },
/* 108 */
/***/ function(module, exports, __webpack_require__) {

	var __WEBPACK_AMD_DEFINE_RESULT__;/* WEBPACK VAR INJECTION */(function(module, global) {/*! https://mths.be/punycode v1.3.2 by @mathias */
	;(function(root) {

		/** Detect free variables */
		var freeExports = typeof exports == 'object' && exports &&
			!exports.nodeType && exports;
		var freeModule = typeof module == 'object' && module &&
			!module.nodeType && module;
		var freeGlobal = typeof global == 'object' && global;
		if (
			freeGlobal.global === freeGlobal ||
			freeGlobal.window === freeGlobal ||
			freeGlobal.self === freeGlobal
		) {
			root = freeGlobal;
		}

		/**
		 * The `punycode` object.
		 * @name punycode
		 * @type Object
		 */
		var punycode,

		/** Highest positive signed 32-bit float value */
		maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

		/** Bootstring parameters */
		base = 36,
		tMin = 1,
		tMax = 26,
		skew = 38,
		damp = 700,
		initialBias = 72,
		initialN = 128, // 0x80
		delimiter = '-', // '\x2D'

		/** Regular expressions */
		regexPunycode = /^xn--/,
		regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
		regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

		/** Error messages */
		errors = {
			'overflow': 'Overflow: input needs wider integers to process',
			'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
			'invalid-input': 'Invalid input'
		},

		/** Convenience shortcuts */
		baseMinusTMin = base - tMin,
		floor = Math.floor,
		stringFromCharCode = String.fromCharCode,

		/** Temporary variable */
		key;

		/*--------------------------------------------------------------------------*/

		/**
		 * A generic error utility function.
		 * @private
		 * @param {String} type The error type.
		 * @returns {Error} Throws a `RangeError` with the applicable error message.
		 */
		function error(type) {
			throw RangeError(errors[type]);
		}

		/**
		 * A generic `Array#map` utility function.
		 * @private
		 * @param {Array} array The array to iterate over.
		 * @param {Function} callback The function that gets called for every array
		 * item.
		 * @returns {Array} A new array of values returned by the callback function.
		 */
		function map(array, fn) {
			var length = array.length;
			var result = [];
			while (length--) {
				result[length] = fn(array[length]);
			}
			return result;
		}

		/**
		 * A simple `Array#map`-like wrapper to work with domain name strings or email
		 * addresses.
		 * @private
		 * @param {String} domain The domain name or email address.
		 * @param {Function} callback The function that gets called for every
		 * character.
		 * @returns {Array} A new string of characters returned by the callback
		 * function.
		 */
		function mapDomain(string, fn) {
			var parts = string.split('@');
			var result = '';
			if (parts.length > 1) {
				// In email addresses, only the domain name should be punycoded. Leave
				// the local part (i.e. everything up to `@`) intact.
				result = parts[0] + '@';
				string = parts[1];
			}
			// Avoid `split(regex)` for IE8 compatibility. See #17.
			string = string.replace(regexSeparators, '\x2E');
			var labels = string.split('.');
			var encoded = map(labels, fn).join('.');
			return result + encoded;
		}

		/**
		 * Creates an array containing the numeric code points of each Unicode
		 * character in the string. While JavaScript uses UCS-2 internally,
		 * this function will convert a pair of surrogate halves (each of which
		 * UCS-2 exposes as separate characters) into a single code point,
		 * matching UTF-16.
		 * @see `punycode.ucs2.encode`
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode.ucs2
		 * @name decode
		 * @param {String} string The Unicode input string (UCS-2).
		 * @returns {Array} The new array of code points.
		 */
		function ucs2decode(string) {
			var output = [],
			    counter = 0,
			    length = string.length,
			    value,
			    extra;
			while (counter < length) {
				value = string.charCodeAt(counter++);
				if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
					// high surrogate, and there is a next character
					extra = string.charCodeAt(counter++);
					if ((extra & 0xFC00) == 0xDC00) { // low surrogate
						output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
					} else {
						// unmatched surrogate; only append this code unit, in case the next
						// code unit is the high surrogate of a surrogate pair
						output.push(value);
						counter--;
					}
				} else {
					output.push(value);
				}
			}
			return output;
		}

		/**
		 * Creates a string based on an array of numeric code points.
		 * @see `punycode.ucs2.decode`
		 * @memberOf punycode.ucs2
		 * @name encode
		 * @param {Array} codePoints The array of numeric code points.
		 * @returns {String} The new Unicode string (UCS-2).
		 */
		function ucs2encode(array) {
			return map(array, function(value) {
				var output = '';
				if (value > 0xFFFF) {
					value -= 0x10000;
					output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
					value = 0xDC00 | value & 0x3FF;
				}
				output += stringFromCharCode(value);
				return output;
			}).join('');
		}

		/**
		 * Converts a basic code point into a digit/integer.
		 * @see `digitToBasic()`
		 * @private
		 * @param {Number} codePoint The basic numeric code point value.
		 * @returns {Number} The numeric value of a basic code point (for use in
		 * representing integers) in the range `0` to `base - 1`, or `base` if
		 * the code point does not represent a value.
		 */
		function basicToDigit(codePoint) {
			if (codePoint - 48 < 10) {
				return codePoint - 22;
			}
			if (codePoint - 65 < 26) {
				return codePoint - 65;
			}
			if (codePoint - 97 < 26) {
				return codePoint - 97;
			}
			return base;
		}

		/**
		 * Converts a digit/integer into a basic code point.
		 * @see `basicToDigit()`
		 * @private
		 * @param {Number} digit The numeric value of a basic code point.
		 * @returns {Number} The basic code point whose value (when used for
		 * representing integers) is `digit`, which needs to be in the range
		 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
		 * used; else, the lowercase form is used. The behavior is undefined
		 * if `flag` is non-zero and `digit` has no uppercase form.
		 */
		function digitToBasic(digit, flag) {
			//  0..25 map to ASCII a..z or A..Z
			// 26..35 map to ASCII 0..9
			return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
		}

		/**
		 * Bias adaptation function as per section 3.4 of RFC 3492.
		 * http://tools.ietf.org/html/rfc3492#section-3.4
		 * @private
		 */
		function adapt(delta, numPoints, firstTime) {
			var k = 0;
			delta = firstTime ? floor(delta / damp) : delta >> 1;
			delta += floor(delta / numPoints);
			for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
				delta = floor(delta / baseMinusTMin);
			}
			return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
		}

		/**
		 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
		 * symbols.
		 * @memberOf punycode
		 * @param {String} input The Punycode string of ASCII-only symbols.
		 * @returns {String} The resulting string of Unicode symbols.
		 */
		function decode(input) {
			// Don't use UCS-2
			var output = [],
			    inputLength = input.length,
			    out,
			    i = 0,
			    n = initialN,
			    bias = initialBias,
			    basic,
			    j,
			    index,
			    oldi,
			    w,
			    k,
			    digit,
			    t,
			    /** Cached calculation results */
			    baseMinusT;

			// Handle the basic code points: let `basic` be the number of input code
			// points before the last delimiter, or `0` if there is none, then copy
			// the first basic code points to the output.

			basic = input.lastIndexOf(delimiter);
			if (basic < 0) {
				basic = 0;
			}

			for (j = 0; j < basic; ++j) {
				// if it's not a basic code point
				if (input.charCodeAt(j) >= 0x80) {
					error('not-basic');
				}
				output.push(input.charCodeAt(j));
			}

			// Main decoding loop: start just after the last delimiter if any basic code
			// points were copied; start at the beginning otherwise.

			for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

				// `index` is the index of the next character to be consumed.
				// Decode a generalized variable-length integer into `delta`,
				// which gets added to `i`. The overflow checking is easier
				// if we increase `i` as we go, then subtract off its starting
				// value at the end to obtain `delta`.
				for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

					if (index >= inputLength) {
						error('invalid-input');
					}

					digit = basicToDigit(input.charCodeAt(index++));

					if (digit >= base || digit > floor((maxInt - i) / w)) {
						error('overflow');
					}

					i += digit * w;
					t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

					if (digit < t) {
						break;
					}

					baseMinusT = base - t;
					if (w > floor(maxInt / baseMinusT)) {
						error('overflow');
					}

					w *= baseMinusT;

				}

				out = output.length + 1;
				bias = adapt(i - oldi, out, oldi == 0);

				// `i` was supposed to wrap around from `out` to `0`,
				// incrementing `n` each time, so we'll fix that now:
				if (floor(i / out) > maxInt - n) {
					error('overflow');
				}

				n += floor(i / out);
				i %= out;

				// Insert `n` at position `i` of the output
				output.splice(i++, 0, n);

			}

			return ucs2encode(output);
		}

		/**
		 * Converts a string of Unicode symbols (e.g. a domain name label) to a
		 * Punycode string of ASCII-only symbols.
		 * @memberOf punycode
		 * @param {String} input The string of Unicode symbols.
		 * @returns {String} The resulting Punycode string of ASCII-only symbols.
		 */
		function encode(input) {
			var n,
			    delta,
			    handledCPCount,
			    basicLength,
			    bias,
			    j,
			    m,
			    q,
			    k,
			    t,
			    currentValue,
			    output = [],
			    /** `inputLength` will hold the number of code points in `input`. */
			    inputLength,
			    /** Cached calculation results */
			    handledCPCountPlusOne,
			    baseMinusT,
			    qMinusT;

			// Convert the input in UCS-2 to Unicode
			input = ucs2decode(input);

			// Cache the length
			inputLength = input.length;

			// Initialize the state
			n = initialN;
			delta = 0;
			bias = initialBias;

			// Handle the basic code points
			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue < 0x80) {
					output.push(stringFromCharCode(currentValue));
				}
			}

			handledCPCount = basicLength = output.length;

			// `handledCPCount` is the number of code points that have been handled;
			// `basicLength` is the number of basic code points.

			// Finish the basic string - if it is not empty - with a delimiter
			if (basicLength) {
				output.push(delimiter);
			}

			// Main encoding loop:
			while (handledCPCount < inputLength) {

				// All non-basic code points < n have been handled already. Find the next
				// larger one:
				for (m = maxInt, j = 0; j < inputLength; ++j) {
					currentValue = input[j];
					if (currentValue >= n && currentValue < m) {
						m = currentValue;
					}
				}

				// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
				// but guard against overflow
				handledCPCountPlusOne = handledCPCount + 1;
				if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
					error('overflow');
				}

				delta += (m - n) * handledCPCountPlusOne;
				n = m;

				for (j = 0; j < inputLength; ++j) {
					currentValue = input[j];

					if (currentValue < n && ++delta > maxInt) {
						error('overflow');
					}

					if (currentValue == n) {
						// Represent delta as a generalized variable-length integer
						for (q = delta, k = base; /* no condition */; k += base) {
							t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
							if (q < t) {
								break;
							}
							qMinusT = q - t;
							baseMinusT = base - t;
							output.push(
								stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
							);
							q = floor(qMinusT / baseMinusT);
						}

						output.push(stringFromCharCode(digitToBasic(q, 0)));
						bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
						delta = 0;
						++handledCPCount;
					}
				}

				++delta;
				++n;

			}
			return output.join('');
		}

		/**
		 * Converts a Punycode string representing a domain name or an email address
		 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
		 * it doesn't matter if you call it on a string that has already been
		 * converted to Unicode.
		 * @memberOf punycode
		 * @param {String} input The Punycoded domain name or email address to
		 * convert to Unicode.
		 * @returns {String} The Unicode representation of the given Punycode
		 * string.
		 */
		function toUnicode(input) {
			return mapDomain(input, function(string) {
				return regexPunycode.test(string)
					? decode(string.slice(4).toLowerCase())
					: string;
			});
		}

		/**
		 * Converts a Unicode string representing a domain name or an email address to
		 * Punycode. Only the non-ASCII parts of the domain name will be converted,
		 * i.e. it doesn't matter if you call it with a domain that's already in
		 * ASCII.
		 * @memberOf punycode
		 * @param {String} input The domain name or email address to convert, as a
		 * Unicode string.
		 * @returns {String} The Punycode representation of the given domain name or
		 * email address.
		 */
		function toASCII(input) {
			return mapDomain(input, function(string) {
				return regexNonASCII.test(string)
					? 'xn--' + encode(string)
					: string;
			});
		}

		/*--------------------------------------------------------------------------*/

		/** Define the public API */
		punycode = {
			/**
			 * A string representing the current Punycode.js version number.
			 * @memberOf punycode
			 * @type String
			 */
			'version': '1.3.2',
			/**
			 * An object of methods to convert from JavaScript's internal character
			 * representation (UCS-2) to Unicode code points, and back.
			 * @see <https://mathiasbynens.be/notes/javascript-encoding>
			 * @memberOf punycode
			 * @type Object
			 */
			'ucs2': {
				'decode': ucs2decode,
				'encode': ucs2encode
			},
			'decode': decode,
			'encode': encode,
			'toASCII': toASCII,
			'toUnicode': toUnicode
		};

		/** Expose `punycode` */
		// Some AMD build optimizers, like r.js, check for specific condition patterns
		// like the following:
		if (
			true
		) {
			!(__WEBPACK_AMD_DEFINE_RESULT__ = function() {
				return punycode;
			}.call(exports, __webpack_require__, exports, module), __WEBPACK_AMD_DEFINE_RESULT__ !== undefined && (module.exports = __WEBPACK_AMD_DEFINE_RESULT__));
		} else if (freeExports && freeModule) {
			if (module.exports == freeExports) { // in Node.js or RingoJS v0.8.0+
				freeModule.exports = punycode;
			} else { // in Narwhal or RingoJS v0.7.0-
				for (key in punycode) {
					punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
				}
			}
		} else { // in Rhino or a web browser
			root.punycode = punycode;
		}

	}(this));
	
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(92)(module), (function() { return this; }())))

/***/ },
/* 109 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	exports.decode = exports.parse = __webpack_require__(116);
	exports.encode = exports.stringify = __webpack_require__(117);


/***/ },
/* 110 */,
/* 111 */,
/* 112 */
/***/ function(module, exports, __webpack_require__) {

	// http://wiki.commonjs.org/wiki/Unit_Testing/1.0
	//
	// THIS IS NOT TESTED NOR LIKELY TO WORK OUTSIDE V8!
	//
	// Originally from narwhal.js (http://narwhaljs.org)
	// Copyright (c) 2009 Thomas Robinson <280north.com>
	//
	// Permission is hereby granted, free of charge, to any person obtaining a copy
	// of this software and associated documentation files (the 'Software'), to
	// deal in the Software without restriction, including without limitation the
	// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
	// sell copies of the Software, and to permit persons to whom the Software is
	// furnished to do so, subject to the following conditions:
	//
	// The above copyright notice and this permission notice shall be included in
	// all copies or substantial portions of the Software.
	//
	// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
	// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
	// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

	// when used in node, this will actually load the util module we depend on
	// versus loading the builtin util module as happens otherwise
	// this is a bug in node module loading as far as I am concerned
	var util = __webpack_require__(122);

	var pSlice = Array.prototype.slice;
	var hasOwn = Object.prototype.hasOwnProperty;

	// 1. The assert module provides functions that throw
	// AssertionError's when particular conditions are not met. The
	// assert module must conform to the following interface.

	var assert = module.exports = ok;

	// 2. The AssertionError is defined in assert.
	// new assert.AssertionError({ message: message,
	//                             actual: actual,
	//                             expected: expected })

	assert.AssertionError = function AssertionError(options) {
	  this.name = 'AssertionError';
	  this.actual = options.actual;
	  this.expected = options.expected;
	  this.operator = options.operator;
	  if (options.message) {
	    this.message = options.message;
	    this.generatedMessage = false;
	  } else {
	    this.message = getMessage(this);
	    this.generatedMessage = true;
	  }
	  var stackStartFunction = options.stackStartFunction || fail;

	  if (Error.captureStackTrace) {
	    Error.captureStackTrace(this, stackStartFunction);
	  }
	  else {
	    // non v8 browsers so we can have a stacktrace
	    var err = new Error();
	    if (err.stack) {
	      var out = err.stack;

	      // try to strip useless frames
	      var fn_name = stackStartFunction.name;
	      var idx = out.indexOf('\n' + fn_name);
	      if (idx >= 0) {
	        // once we have located the function frame
	        // we need to strip out everything before it (and its line)
	        var next_line = out.indexOf('\n', idx + 1);
	        out = out.substring(next_line + 1);
	      }

	      this.stack = out;
	    }
	  }
	};

	// assert.AssertionError instanceof Error
	util.inherits(assert.AssertionError, Error);

	function replacer(key, value) {
	  if (util.isUndefined(value)) {
	    return '' + value;
	  }
	  if (util.isNumber(value) && !isFinite(value)) {
	    return value.toString();
	  }
	  if (util.isFunction(value) || util.isRegExp(value)) {
	    return value.toString();
	  }
	  return value;
	}

	function truncate(s, n) {
	  if (util.isString(s)) {
	    return s.length < n ? s : s.slice(0, n);
	  } else {
	    return s;
	  }
	}

	function getMessage(self) {
	  return truncate(JSON.stringify(self.actual, replacer), 128) + ' ' +
	         self.operator + ' ' +
	         truncate(JSON.stringify(self.expected, replacer), 128);
	}

	// At present only the three keys mentioned above are used and
	// understood by the spec. Implementations or sub modules can pass
	// other keys to the AssertionError's constructor - they will be
	// ignored.

	// 3. All of the following functions must throw an AssertionError
	// when a corresponding condition is not met, with a message that
	// may be undefined if not provided.  All assertion methods provide
	// both the actual and expected values to the assertion error for
	// display purposes.

	function fail(actual, expected, message, operator, stackStartFunction) {
	  throw new assert.AssertionError({
	    message: message,
	    actual: actual,
	    expected: expected,
	    operator: operator,
	    stackStartFunction: stackStartFunction
	  });
	}

	// EXTENSION! allows for well behaved errors defined elsewhere.
	assert.fail = fail;

	// 4. Pure assertion tests whether a value is truthy, as determined
	// by !!guard.
	// assert.ok(guard, message_opt);
	// This statement is equivalent to assert.equal(true, !!guard,
	// message_opt);. To test strictly for the value true, use
	// assert.strictEqual(true, guard, message_opt);.

	function ok(value, message) {
	  if (!value) fail(value, true, message, '==', assert.ok);
	}
	assert.ok = ok;

	// 5. The equality assertion tests shallow, coercive equality with
	// ==.
	// assert.equal(actual, expected, message_opt);

	assert.equal = function equal(actual, expected, message) {
	  if (actual != expected) fail(actual, expected, message, '==', assert.equal);
	};

	// 6. The non-equality assertion tests for whether two objects are not equal
	// with != assert.notEqual(actual, expected, message_opt);

	assert.notEqual = function notEqual(actual, expected, message) {
	  if (actual == expected) {
	    fail(actual, expected, message, '!=', assert.notEqual);
	  }
	};

	// 7. The equivalence assertion tests a deep equality relation.
	// assert.deepEqual(actual, expected, message_opt);

	assert.deepEqual = function deepEqual(actual, expected, message) {
	  if (!_deepEqual(actual, expected)) {
	    fail(actual, expected, message, 'deepEqual', assert.deepEqual);
	  }
	};

	function _deepEqual(actual, expected) {
	  // 7.1. All identical values are equivalent, as determined by ===.
	  if (actual === expected) {
	    return true;

	  } else if (util.isBuffer(actual) && util.isBuffer(expected)) {
	    if (actual.length != expected.length) return false;

	    for (var i = 0; i < actual.length; i++) {
	      if (actual[i] !== expected[i]) return false;
	    }

	    return true;

	  // 7.2. If the expected value is a Date object, the actual value is
	  // equivalent if it is also a Date object that refers to the same time.
	  } else if (util.isDate(actual) && util.isDate(expected)) {
	    return actual.getTime() === expected.getTime();

	  // 7.3 If the expected value is a RegExp object, the actual value is
	  // equivalent if it is also a RegExp object with the same source and
	  // properties (`global`, `multiline`, `lastIndex`, `ignoreCase`).
	  } else if (util.isRegExp(actual) && util.isRegExp(expected)) {
	    return actual.source === expected.source &&
	           actual.global === expected.global &&
	           actual.multiline === expected.multiline &&
	           actual.lastIndex === expected.lastIndex &&
	           actual.ignoreCase === expected.ignoreCase;

	  // 7.4. Other pairs that do not both pass typeof value == 'object',
	  // equivalence is determined by ==.
	  } else if (!util.isObject(actual) && !util.isObject(expected)) {
	    return actual == expected;

	  // 7.5 For all other Object pairs, including Array objects, equivalence is
	  // determined by having the same number of owned properties (as verified
	  // with Object.prototype.hasOwnProperty.call), the same set of keys
	  // (although not necessarily the same order), equivalent values for every
	  // corresponding key, and an identical 'prototype' property. Note: this
	  // accounts for both named and indexed properties on Arrays.
	  } else {
	    return objEquiv(actual, expected);
	  }
	}

	function isArguments(object) {
	  return Object.prototype.toString.call(object) == '[object Arguments]';
	}

	function objEquiv(a, b) {
	  if (util.isNullOrUndefined(a) || util.isNullOrUndefined(b))
	    return false;
	  // an identical 'prototype' property.
	  if (a.prototype !== b.prototype) return false;
	  // if one is a primitive, the other must be same
	  if (util.isPrimitive(a) || util.isPrimitive(b)) {
	    return a === b;
	  }
	  var aIsArgs = isArguments(a),
	      bIsArgs = isArguments(b);
	  if ((aIsArgs && !bIsArgs) || (!aIsArgs && bIsArgs))
	    return false;
	  if (aIsArgs) {
	    a = pSlice.call(a);
	    b = pSlice.call(b);
	    return _deepEqual(a, b);
	  }
	  var ka = objectKeys(a),
	      kb = objectKeys(b),
	      key, i;
	  // having the same number of owned properties (keys incorporates
	  // hasOwnProperty)
	  if (ka.length != kb.length)
	    return false;
	  //the same set of keys (although not necessarily the same order),
	  ka.sort();
	  kb.sort();
	  //~~~cheap key test
	  for (i = ka.length - 1; i >= 0; i--) {
	    if (ka[i] != kb[i])
	      return false;
	  }
	  //equivalent values for every corresponding key, and
	  //~~~possibly expensive deep test
	  for (i = ka.length - 1; i >= 0; i--) {
	    key = ka[i];
	    if (!_deepEqual(a[key], b[key])) return false;
	  }
	  return true;
	}

	// 8. The non-equivalence assertion tests for any deep inequality.
	// assert.notDeepEqual(actual, expected, message_opt);

	assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
	  if (_deepEqual(actual, expected)) {
	    fail(actual, expected, message, 'notDeepEqual', assert.notDeepEqual);
	  }
	};

	// 9. The strict equality assertion tests strict equality, as determined by ===.
	// assert.strictEqual(actual, expected, message_opt);

	assert.strictEqual = function strictEqual(actual, expected, message) {
	  if (actual !== expected) {
	    fail(actual, expected, message, '===', assert.strictEqual);
	  }
	};

	// 10. The strict non-equality assertion tests for strict inequality, as
	// determined by !==.  assert.notStrictEqual(actual, expected, message_opt);

	assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
	  if (actual === expected) {
	    fail(actual, expected, message, '!==', assert.notStrictEqual);
	  }
	};

	function expectedException(actual, expected) {
	  if (!actual || !expected) {
	    return false;
	  }

	  if (Object.prototype.toString.call(expected) == '[object RegExp]') {
	    return expected.test(actual);
	  } else if (actual instanceof expected) {
	    return true;
	  } else if (expected.call({}, actual) === true) {
	    return true;
	  }

	  return false;
	}

	function _throws(shouldThrow, block, expected, message) {
	  var actual;

	  if (util.isString(expected)) {
	    message = expected;
	    expected = null;
	  }

	  try {
	    block();
	  } catch (e) {
	    actual = e;
	  }

	  message = (expected && expected.name ? ' (' + expected.name + ').' : '.') +
	            (message ? ' ' + message : '.');

	  if (shouldThrow && !actual) {
	    fail(actual, expected, 'Missing expected exception' + message);
	  }

	  if (!shouldThrow && expectedException(actual, expected)) {
	    fail(actual, expected, 'Got unwanted exception' + message);
	  }

	  if ((shouldThrow && actual && expected &&
	      !expectedException(actual, expected)) || (!shouldThrow && actual)) {
	    throw actual;
	  }
	}

	// 11. Expected to throw an error:
	// assert.throws(block, Error_opt, message_opt);

	assert.throws = function(block, /*optional*/error, /*optional*/message) {
	  _throws.apply(this, [true].concat(pSlice.call(arguments)));
	};

	// EXTENSION! This is annoying to write outside this module.
	assert.doesNotThrow = function(block, /*optional*/message) {
	  _throws.apply(this, [false].concat(pSlice.call(arguments)));
	};

	assert.ifError = function(err) { if (err) {throw err;}};

	var objectKeys = Object.keys || function (obj) {
	  var keys = [];
	  for (var key in obj) {
	    if (hasOwn.call(obj, key)) keys.push(key);
	  }
	  return keys;
	};


/***/ },
/* 113 */
/***/ function(module, exports, __webpack_require__) {

	// shim for using process in browser

	var process = module.exports = {};

	process.nextTick = (function () {
	    var canSetImmediate = typeof window !== 'undefined'
	    && window.setImmediate;
	    var canMutationObserver = typeof window !== 'undefined'
	    && window.MutationObserver;
	    var canPost = typeof window !== 'undefined'
	    && window.postMessage && window.addEventListener
	    ;

	    if (canSetImmediate) {
	        return function (f) { return window.setImmediate(f) };
	    }

	    var queue = [];

	    if (canMutationObserver) {
	        var hiddenDiv = document.createElement("div");
	        var observer = new MutationObserver(function () {
	            var queueList = queue.slice();
	            queue.length = 0;
	            queueList.forEach(function (fn) {
	                fn();
	            });
	        });

	        observer.observe(hiddenDiv, { attributes: true });

	        return function nextTick(fn) {
	            if (!queue.length) {
	                hiddenDiv.setAttribute('yes', 'no');
	            }
	            queue.push(fn);
	        };
	    }

	    if (canPost) {
	        window.addEventListener('message', function (ev) {
	            var source = ev.source;
	            if ((source === window || source === null) && ev.data === 'process-tick') {
	                ev.stopPropagation();
	                if (queue.length > 0) {
	                    var fn = queue.shift();
	                    fn();
	                }
	            }
	        }, true);

	        return function nextTick(fn) {
	            queue.push(fn);
	            window.postMessage('process-tick', '*');
	        };
	    }

	    return function nextTick(fn) {
	        setTimeout(fn, 0);
	    };
	})();

	process.title = 'browser';
	process.browser = true;
	process.env = {};
	process.argv = [];

	function noop() {}

	process.on = noop;
	process.addListener = noop;
	process.once = noop;
	process.off = noop;
	process.removeListener = noop;
	process.removeAllListeners = noop;
	process.emit = noop;

	process.binding = function (name) {
	    throw new Error('process.binding is not supported');
	};

	// TODO(shtylman)
	process.cwd = function () { return '/' };
	process.chdir = function (dir) {
	    throw new Error('process.chdir is not supported');
	};


/***/ },
/* 114 */
/***/ function(module, exports, __webpack_require__) {

	if (typeof Object.create === 'function') {
	  // implementation from standard node.js 'util' module
	  module.exports = function inherits(ctor, superCtor) {
	    ctor.super_ = superCtor
	    ctor.prototype = Object.create(superCtor.prototype, {
	      constructor: {
	        value: ctor,
	        enumerable: false,
	        writable: true,
	        configurable: true
	      }
	    });
	  };
	} else {
	  // old school shim for old browsers
	  module.exports = function inherits(ctor, superCtor) {
	    ctor.super_ = superCtor
	    var TempCtor = function () {}
	    TempCtor.prototype = superCtor.prototype
	    ctor.prototype = new TempCtor()
	    ctor.prototype.constructor = ctor
	  }
	}


/***/ },
/* 115 */
/***/ function(module, exports, __webpack_require__) {

	var __WEBPACK_AMD_DEFINE_FACTORY__, __WEBPACK_AMD_DEFINE_RESULT__;/*
	 * loglevel - https://github.com/pimterry/loglevel
	 *
	 * Copyright (c) 2013 Tim Perry
	 * Licensed under the MIT license.
	 */
	(function (root, definition) {
	    "use strict";

	    if (typeof module === 'object' && module.exports && "function" === 'function') {
	        module.exports = definition();
	    } else if (true) {
	        !(__WEBPACK_AMD_DEFINE_FACTORY__ = (definition), __WEBPACK_AMD_DEFINE_RESULT__ = (typeof __WEBPACK_AMD_DEFINE_FACTORY__ === 'function' ? (__WEBPACK_AMD_DEFINE_FACTORY__.call(exports, __webpack_require__, exports, module)) : __WEBPACK_AMD_DEFINE_FACTORY__), __WEBPACK_AMD_DEFINE_RESULT__ !== undefined && (module.exports = __WEBPACK_AMD_DEFINE_RESULT__));
	    } else {
	        root.log = definition();
	    }
	}(this, function () {
	    /*global console, window*/
	    "use strict";

	    var self = {};
	    var noop = function() {};
	    var undefinedType = "undefined";

	    function realMethod(methodName) {
	        if (typeof console === undefinedType) {
	            return false; // We can't build a real method without a console to log to
	        } else if (console[methodName] !== undefined) {
	            return bindMethod(console, methodName);
	        } else if (console.log !== undefined) {
	            return bindMethod(console, 'log');
	        } else {
	            return noop;
	        }
	    }

	    function bindMethod(obj, methodName) {
	        var method = obj[methodName];
	        if (typeof method.bind === 'function') {
	            return method.bind(obj);
	        } else {
	            try {
	                return Function.prototype.bind.call(method, obj);
	            } catch (e) {
	                // Missing bind shim or IE8 + Modernizr, fallback to wrapping
	                return function() {
	                    return Function.prototype.apply.apply(method, [obj, arguments]);
	                };
	            }
	        }
	    }

	    function enableLoggingWhenConsoleArrives(methodName, level) {
	        return function () {
	            if (typeof console !== undefinedType) {
	                replaceLoggingMethods(level);
	                self[methodName].apply(self, arguments);
	            }
	        };
	    }

	    var logMethods = [
	        "trace",
	        "debug",
	        "info",
	        "warn",
	        "error"
	    ];

	    function replaceLoggingMethods(level) {
	        var methodName;
	        for (var i = 0; i < logMethods.length; i++) {
	            methodName = logMethods[i];
	            self[methodName] = (i < level) ? noop : self.methodFactory(methodName, level);
	        }

	        // Additional `log` method to make a complete drop-in `console` replacement.
	        methodName = "log";
	        self[methodName] = (self.levels.INFO < level) ? noop : self.methodFactory(methodName, level);
	    }

	    /*
	     *
	     * Public API
	     *
	     */

	    self.levels = {
	        "TRACE": 0,
	        "DEBUG": 1,
	        "INFO": 2,
	        "WARN": 3,
	        "ERROR": 4,
	        "SILENT": 5
	    };

	    self.methodFactory = function (methodName, level) {
	        return realMethod(methodName) ||
	               enableLoggingWhenConsoleArrives(methodName, level);
	    };

	    self.setLevel = function (level) {
	        if (typeof level === "string" && self.levels[level.toUpperCase()] !== undefined) {
	            level = self.levels[level.toUpperCase()];
	        }
	        if (typeof level === "number" && level >= 0 && level <= self.levels.SILENT) {
	            replaceLoggingMethods(level);
	            if (typeof console === undefinedType && level < self.levels.SILENT) {
	                // No console available for logging. Do not throw, cannot fix it.
	                return false;
	            }
	        } else {
	            throw new Error("log.setLevel() called with invalid level: " + level);
	        }
	    };

	    self.enableAll = function() {
	        self.setLevel(self.levels.TRACE);
	    };

	    self.disableAll = function() {
	        self.setLevel(self.levels.SILENT);
	    };

	    // Grab the current global log variable in case of overwrite
	    var _log = (typeof window !== undefinedType) ? window.log : undefined;
	    self.noConflict = function() {
	        if (typeof window !== undefinedType &&
	               window.log === self) {
	            window.log = _log;
	        }

	        return self;
	    };

	    // Log level persistence has been removed, enable logging by default.
	    self.enableAll();
	    return self;
	}));


/***/ },
/* 116 */
/***/ function(module, exports, __webpack_require__) {

	// Copyright Joyent, Inc. and other Node contributors.
	//
	// Permission is hereby granted, free of charge, to any person obtaining a
	// copy of this software and associated documentation files (the
	// "Software"), to deal in the Software without restriction, including
	// without limitation the rights to use, copy, modify, merge, publish,
	// distribute, sublicense, and/or sell copies of the Software, and to permit
	// persons to whom the Software is furnished to do so, subject to the
	// following conditions:
	//
	// The above copyright notice and this permission notice shall be included
	// in all copies or substantial portions of the Software.
	//
	// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
	// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
	// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
	// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
	// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
	// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
	// USE OR OTHER DEALINGS IN THE SOFTWARE.

	'use strict';

	// If obj.hasOwnProperty has been overridden, then calling
	// obj.hasOwnProperty(prop) will break.
	// See: https://github.com/joyent/node/issues/1707
	function hasOwnProperty(obj, prop) {
	  return Object.prototype.hasOwnProperty.call(obj, prop);
	}

	module.exports = function(qs, sep, eq, options) {
	  sep = sep || '&';
	  eq = eq || '=';
	  var obj = {};

	  if (typeof qs !== 'string' || qs.length === 0) {
	    return obj;
	  }

	  var regexp = /\+/g;
	  qs = qs.split(sep);

	  var maxKeys = 1000;
	  if (options && typeof options.maxKeys === 'number') {
	    maxKeys = options.maxKeys;
	  }

	  var len = qs.length;
	  // maxKeys <= 0 means that we should not limit keys count
	  if (maxKeys > 0 && len > maxKeys) {
	    len = maxKeys;
	  }

	  for (var i = 0; i < len; ++i) {
	    var x = qs[i].replace(regexp, '%20'),
	        idx = x.indexOf(eq),
	        kstr, vstr, k, v;

	    if (idx >= 0) {
	      kstr = x.substr(0, idx);
	      vstr = x.substr(idx + 1);
	    } else {
	      kstr = x;
	      vstr = '';
	    }

	    k = decodeURIComponent(kstr);
	    v = decodeURIComponent(vstr);

	    if (!hasOwnProperty(obj, k)) {
	      obj[k] = v;
	    } else if (isArray(obj[k])) {
	      obj[k].push(v);
	    } else {
	      obj[k] = [obj[k], v];
	    }
	  }

	  return obj;
	};

	var isArray = Array.isArray || function (xs) {
	  return Object.prototype.toString.call(xs) === '[object Array]';
	};


/***/ },
/* 117 */
/***/ function(module, exports, __webpack_require__) {

	// Copyright Joyent, Inc. and other Node contributors.
	//
	// Permission is hereby granted, free of charge, to any person obtaining a
	// copy of this software and associated documentation files (the
	// "Software"), to deal in the Software without restriction, including
	// without limitation the rights to use, copy, modify, merge, publish,
	// distribute, sublicense, and/or sell copies of the Software, and to permit
	// persons to whom the Software is furnished to do so, subject to the
	// following conditions:
	//
	// The above copyright notice and this permission notice shall be included
	// in all copies or substantial portions of the Software.
	//
	// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
	// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
	// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
	// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
	// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
	// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
	// USE OR OTHER DEALINGS IN THE SOFTWARE.

	'use strict';

	var stringifyPrimitive = function(v) {
	  switch (typeof v) {
	    case 'string':
	      return v;

	    case 'boolean':
	      return v ? 'true' : 'false';

	    case 'number':
	      return isFinite(v) ? v : '';

	    default:
	      return '';
	  }
	};

	module.exports = function(obj, sep, eq, name) {
	  sep = sep || '&';
	  eq = eq || '=';
	  if (obj === null) {
	    obj = undefined;
	  }

	  if (typeof obj === 'object') {
	    return map(objectKeys(obj), function(k) {
	      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
	      if (isArray(obj[k])) {
	        return map(obj[k], function(v) {
	          return ks + encodeURIComponent(stringifyPrimitive(v));
	        }).join(sep);
	      } else {
	        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
	      }
	    }).join(sep);

	  }

	  if (!name) return '';
	  return encodeURIComponent(stringifyPrimitive(name)) + eq +
	         encodeURIComponent(stringifyPrimitive(obj));
	};

	var isArray = Array.isArray || function (xs) {
	  return Object.prototype.toString.call(xs) === '[object Array]';
	};

	function map (xs, f) {
	  if (xs.map) return xs.map(f);
	  var res = [];
	  for (var i = 0; i < xs.length; i++) {
	    res.push(f(xs[i], i));
	  }
	  return res;
	}

	var objectKeys = Object.keys || function (obj) {
	  var res = [];
	  for (var key in obj) {
	    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
	  }
	  return res;
	};


/***/ },
/* 118 */
/***/ function(module, exports, __webpack_require__) {

	// style-loader: Adds some css to the DOM by adding a <style> tag

	// load the styles
	var content = __webpack_require__(119);
	if(typeof content === 'string') content = [[module.id, content, '']];
	// add the styles to the DOM
	var update = __webpack_require__(9)(content, {});
	// Hot Module Replacement
	if(false) {
		// When the styles change, update the <style> tags
		module.hot.accept("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/dashboard-layout.less", function() {
			var newContent = require("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/dashboard-layout.less");
			if(typeof newContent === 'string') newContent = [[module.id, newContent, '']];
			update(newContent);
		});
		// When the module is disposed, remove the <style> tags
		module.hot.dispose(function() { update(); });
	}

/***/ },
/* 119 */
/***/ function(module, exports, __webpack_require__) {

	exports = module.exports = __webpack_require__(11)();
	exports.push([module.id, ".knsh-dashboard-layout {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n}\n.knsh-dashboard-layout-group {\n  display: -webkit-box;\n  display: -moz-box;\n  display: -ms-box;\n  display: -o-box;\n  display: box;\n  display: -ms-flexbox;\n  display: -webkit-flex;\n  display: -moz-flex;\n  display: -ms-flex;\n  display: -o-flex;\n  display: flex;\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  width: 100%;\n}\n.knsh-dashboard-layout-group__items {\n  display: -webkit-box;\n  display: -moz-box;\n  display: -ms-box;\n  display: -o-box;\n  display: box;\n  display: -ms-flexbox;\n  display: -webkit-flex;\n  display: -moz-flex;\n  display: -ms-flex;\n  display: -o-flex;\n  display: flex;\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  width: 100%;\n}\n.knsh-dashboard-layout-group__item {\n  display: -webkit-box;\n  display: -moz-box;\n  display: -ms-box;\n  display: -o-box;\n  display: box;\n  display: -ms-flexbox;\n  display: -webkit-flex;\n  display: -moz-flex;\n  display: -ms-flex;\n  display: -o-flex;\n  display: flex;\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  width: 100%;\n}\n.knsh-dashboard-layout-group__m-row > .knsh-dashboard-layout-group__items {\n  -webkit-box-orient: horizontal;\n  -moz-box-orient: horizontal;\n  -ms-box-orient: horizontal;\n  -o-box-orient: horizontal;\n  box-orient: horizontal;\n  -webkit-flex-direction: row;\n  -moz-flex-direction: row;\n  -ms-flex-direction: row;\n  -o-flex-direction: row;\n  flex-direction: row;\n}\n@media (max-width: 768px) {\n  .knsh-dashboard-layout-group__m-row > .knsh-dashboard-layout-group__items {\n    -webkit-lines: multiple;\n    -webkit-box-lines: multiple;\n    -moz-box-lines: multiple;\n    -ms-box-lines: multiple;\n    -o-box-lines: multiple;\n    box-lines: multiple;\n    -webkit-flex-wrap: wrap;\n    -moz-flex-wrap: wrap;\n    -ms-flex-wrap: wrap;\n    -o-flex-wrap: wrap;\n    flex-wrap: wrap;\n  }\n}\n.knsh-dashboard-layout-group__m-col > .knsh-dashboard-layout-group__items {\n  -webkit-box-orient: vertical;\n  -moz-box-orient: vertical;\n  -ms-box-orient: vertical;\n  -o-box-orient: vertical;\n  box-orient: vertical;\n  -webkit-flex-direction: column;\n  -moz-flex-direction: column;\n  -ms-flex-direction: column;\n  -o-flex-direction: column;\n  flex-direction: column;\n}\n.knsh-dashboard-layout-card {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n  border: 0 none;\n  width: 100%;\n}\n", ""]);

/***/ },
/* 120 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var $ = __webpack_require__(3);

	/**
	 * Converts an array, object to a string intended to be used as CSS classes.
	 * 
	 * Examples:
	    * ```javascript
	         [ "css-class-1", "css-class-2" ] // -> "css-class-1 css-class-2"
	```
	    * ```javascript
	         "   css-class-1   css-class-2  " // -> "css-class-1 css-class-2"
	```
	    * ```javascript
	         {
	             "css-class-1": true,
	             "css-class-2": true,
	             "css-class-3": false
	         }
	         // -> "css-class-1 css-class-2"
	```
	 * 
	 * @param {string|Array.<string>|Object.<string,boolean>} 
	 * @return {string}
	 */
	function makeStringFromOptions(cssClasses) {
		var cssClassesString = '';
		
		if ($.isArray(cssClasses)) {
			// [ "css-class-1", "css-class-2" ]
			cssClassesString = cssClasses.join(' ');
		}
		else if (typeof cssClasses === 'string' || cssClasses instanceof String) {
			// "css-class-1 css-class-2"
			cssClassesString = cssClasses;
		}
		else if ($.isPlainObject(cssClasses)) {
			// { "css-class-1": true, "css-class-2": true, "css-class-3": false }
			$.each(cssClasses, function (k, v) {
				if (k && v === true) {
					cssClassesString += ' ' + k;
				}
			});
		}
		
		cssClassesString = cssClassesString.replace(/\s+/g, ' ').replace(/(^\s+)|(\s+$)/g, '');
		
		return cssClassesString;
	}

	module.exports = makeStringFromOptions;


/***/ },
/* 121 */
/***/ function(module, exports, __webpack_require__) {

	var map = {
		"./image-visualizer": 123,
		"./image-visualizer.js": 123,
		"./image-visualizer.less": 124,
		"./plot-visualizer": 126,
		"./plot-visualizer.js": 126,
		"./plot-visualizer.less": 127,
		"./value-visualizer": 129,
		"./value-visualizer.js": 129,
		"./value-visualizer.less": 130
	};
	function webpackContext(req) {
		return __webpack_require__(webpackContextResolve(req));
	};
	function webpackContextResolve(req) {
		return map[req] || (function() { throw new Error("Cannot find module '" + req + "'.") }());
	};
	webpackContext.keys = function webpackContextKeys() {
		return Object.keys(map);
	};
	webpackContext.resolve = webpackContextResolve;
	module.exports = webpackContext;
	webpackContext.id = 121;


/***/ },
/* 122 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(global, process) {// Copyright Joyent, Inc. and other Node contributors.
	//
	// Permission is hereby granted, free of charge, to any person obtaining a
	// copy of this software and associated documentation files (the
	// "Software"), to deal in the Software without restriction, including
	// without limitation the rights to use, copy, modify, merge, publish,
	// distribute, sublicense, and/or sell copies of the Software, and to permit
	// persons to whom the Software is furnished to do so, subject to the
	// following conditions:
	//
	// The above copyright notice and this permission notice shall be included
	// in all copies or substantial portions of the Software.
	//
	// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
	// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
	// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
	// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
	// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
	// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
	// USE OR OTHER DEALINGS IN THE SOFTWARE.

	var formatRegExp = /%[sdj%]/g;
	exports.format = function(f) {
	  if (!isString(f)) {
	    var objects = [];
	    for (var i = 0; i < arguments.length; i++) {
	      objects.push(inspect(arguments[i]));
	    }
	    return objects.join(' ');
	  }

	  var i = 1;
	  var args = arguments;
	  var len = args.length;
	  var str = String(f).replace(formatRegExp, function(x) {
	    if (x === '%%') return '%';
	    if (i >= len) return x;
	    switch (x) {
	      case '%s': return String(args[i++]);
	      case '%d': return Number(args[i++]);
	      case '%j':
	        try {
	          return JSON.stringify(args[i++]);
	        } catch (_) {
	          return '[Circular]';
	        }
	      default:
	        return x;
	    }
	  });
	  for (var x = args[i]; i < len; x = args[++i]) {
	    if (isNull(x) || !isObject(x)) {
	      str += ' ' + x;
	    } else {
	      str += ' ' + inspect(x);
	    }
	  }
	  return str;
	};


	// Mark that a method should not be used.
	// Returns a modified function which warns once by default.
	// If --no-deprecation is set, then it is a no-op.
	exports.deprecate = function(fn, msg) {
	  // Allow for deprecating things in the process of starting up.
	  if (isUndefined(global.process)) {
	    return function() {
	      return exports.deprecate(fn, msg).apply(this, arguments);
	    };
	  }

	  if (process.noDeprecation === true) {
	    return fn;
	  }

	  var warned = false;
	  function deprecated() {
	    if (!warned) {
	      if (process.throwDeprecation) {
	        throw new Error(msg);
	      } else if (process.traceDeprecation) {
	        console.trace(msg);
	      } else {
	        console.error(msg);
	      }
	      warned = true;
	    }
	    return fn.apply(this, arguments);
	  }

	  return deprecated;
	};


	var debugs = {};
	var debugEnviron;
	exports.debuglog = function(set) {
	  if (isUndefined(debugEnviron))
	    debugEnviron = process.env.NODE_DEBUG || '';
	  set = set.toUpperCase();
	  if (!debugs[set]) {
	    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
	      var pid = process.pid;
	      debugs[set] = function() {
	        var msg = exports.format.apply(exports, arguments);
	        console.error('%s %d: %s', set, pid, msg);
	      };
	    } else {
	      debugs[set] = function() {};
	    }
	  }
	  return debugs[set];
	};


	/**
	 * Echos the value of a value. Trys to print the value out
	 * in the best way possible given the different types.
	 *
	 * @param {Object} obj The object to print out.
	 * @param {Object} opts Optional options object that alters the output.
	 */
	/* legacy: obj, showHidden, depth, colors*/
	function inspect(obj, opts) {
	  // default options
	  var ctx = {
	    seen: [],
	    stylize: stylizeNoColor
	  };
	  // legacy...
	  if (arguments.length >= 3) ctx.depth = arguments[2];
	  if (arguments.length >= 4) ctx.colors = arguments[3];
	  if (isBoolean(opts)) {
	    // legacy...
	    ctx.showHidden = opts;
	  } else if (opts) {
	    // got an "options" object
	    exports._extend(ctx, opts);
	  }
	  // set default options
	  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
	  if (isUndefined(ctx.depth)) ctx.depth = 2;
	  if (isUndefined(ctx.colors)) ctx.colors = false;
	  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
	  if (ctx.colors) ctx.stylize = stylizeWithColor;
	  return formatValue(ctx, obj, ctx.depth);
	}
	exports.inspect = inspect;


	// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
	inspect.colors = {
	  'bold' : [1, 22],
	  'italic' : [3, 23],
	  'underline' : [4, 24],
	  'inverse' : [7, 27],
	  'white' : [37, 39],
	  'grey' : [90, 39],
	  'black' : [30, 39],
	  'blue' : [34, 39],
	  'cyan' : [36, 39],
	  'green' : [32, 39],
	  'magenta' : [35, 39],
	  'red' : [31, 39],
	  'yellow' : [33, 39]
	};

	// Don't use 'blue' not visible on cmd.exe
	inspect.styles = {
	  'special': 'cyan',
	  'number': 'yellow',
	  'boolean': 'yellow',
	  'undefined': 'grey',
	  'null': 'bold',
	  'string': 'green',
	  'date': 'magenta',
	  // "name": intentionally not styling
	  'regexp': 'red'
	};


	function stylizeWithColor(str, styleType) {
	  var style = inspect.styles[styleType];

	  if (style) {
	    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
	           '\u001b[' + inspect.colors[style][1] + 'm';
	  } else {
	    return str;
	  }
	}


	function stylizeNoColor(str, styleType) {
	  return str;
	}


	function arrayToHash(array) {
	  var hash = {};

	  array.forEach(function(val, idx) {
	    hash[val] = true;
	  });

	  return hash;
	}


	function formatValue(ctx, value, recurseTimes) {
	  // Provide a hook for user-specified inspect functions.
	  // Check that value is an object with an inspect function on it
	  if (ctx.customInspect &&
	      value &&
	      isFunction(value.inspect) &&
	      // Filter out the util module, it's inspect function is special
	      value.inspect !== exports.inspect &&
	      // Also filter out any prototype objects using the circular check.
	      !(value.constructor && value.constructor.prototype === value)) {
	    var ret = value.inspect(recurseTimes, ctx);
	    if (!isString(ret)) {
	      ret = formatValue(ctx, ret, recurseTimes);
	    }
	    return ret;
	  }

	  // Primitive types cannot have properties
	  var primitive = formatPrimitive(ctx, value);
	  if (primitive) {
	    return primitive;
	  }

	  // Look up the keys of the object.
	  var keys = Object.keys(value);
	  var visibleKeys = arrayToHash(keys);

	  if (ctx.showHidden) {
	    keys = Object.getOwnPropertyNames(value);
	  }

	  // IE doesn't make error fields non-enumerable
	  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
	  if (isError(value)
	      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
	    return formatError(value);
	  }

	  // Some type of object without properties can be shortcutted.
	  if (keys.length === 0) {
	    if (isFunction(value)) {
	      var name = value.name ? ': ' + value.name : '';
	      return ctx.stylize('[Function' + name + ']', 'special');
	    }
	    if (isRegExp(value)) {
	      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
	    }
	    if (isDate(value)) {
	      return ctx.stylize(Date.prototype.toString.call(value), 'date');
	    }
	    if (isError(value)) {
	      return formatError(value);
	    }
	  }

	  var base = '', array = false, braces = ['{', '}'];

	  // Make Array say that they are Array
	  if (isArray(value)) {
	    array = true;
	    braces = ['[', ']'];
	  }

	  // Make functions say that they are functions
	  if (isFunction(value)) {
	    var n = value.name ? ': ' + value.name : '';
	    base = ' [Function' + n + ']';
	  }

	  // Make RegExps say that they are RegExps
	  if (isRegExp(value)) {
	    base = ' ' + RegExp.prototype.toString.call(value);
	  }

	  // Make dates with properties first say the date
	  if (isDate(value)) {
	    base = ' ' + Date.prototype.toUTCString.call(value);
	  }

	  // Make error with message first say the error
	  if (isError(value)) {
	    base = ' ' + formatError(value);
	  }

	  if (keys.length === 0 && (!array || value.length == 0)) {
	    return braces[0] + base + braces[1];
	  }

	  if (recurseTimes < 0) {
	    if (isRegExp(value)) {
	      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
	    } else {
	      return ctx.stylize('[Object]', 'special');
	    }
	  }

	  ctx.seen.push(value);

	  var output;
	  if (array) {
	    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
	  } else {
	    output = keys.map(function(key) {
	      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
	    });
	  }

	  ctx.seen.pop();

	  return reduceToSingleString(output, base, braces);
	}


	function formatPrimitive(ctx, value) {
	  if (isUndefined(value))
	    return ctx.stylize('undefined', 'undefined');
	  if (isString(value)) {
	    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
	                                             .replace(/'/g, "\\'")
	                                             .replace(/\\"/g, '"') + '\'';
	    return ctx.stylize(simple, 'string');
	  }
	  if (isNumber(value))
	    return ctx.stylize('' + value, 'number');
	  if (isBoolean(value))
	    return ctx.stylize('' + value, 'boolean');
	  // For some reason typeof null is "object", so special case here.
	  if (isNull(value))
	    return ctx.stylize('null', 'null');
	}


	function formatError(value) {
	  return '[' + Error.prototype.toString.call(value) + ']';
	}


	function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
	  var output = [];
	  for (var i = 0, l = value.length; i < l; ++i) {
	    if (hasOwnProperty(value, String(i))) {
	      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
	          String(i), true));
	    } else {
	      output.push('');
	    }
	  }
	  keys.forEach(function(key) {
	    if (!key.match(/^\d+$/)) {
	      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
	          key, true));
	    }
	  });
	  return output;
	}


	function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
	  var name, str, desc;
	  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
	  if (desc.get) {
	    if (desc.set) {
	      str = ctx.stylize('[Getter/Setter]', 'special');
	    } else {
	      str = ctx.stylize('[Getter]', 'special');
	    }
	  } else {
	    if (desc.set) {
	      str = ctx.stylize('[Setter]', 'special');
	    }
	  }
	  if (!hasOwnProperty(visibleKeys, key)) {
	    name = '[' + key + ']';
	  }
	  if (!str) {
	    if (ctx.seen.indexOf(desc.value) < 0) {
	      if (isNull(recurseTimes)) {
	        str = formatValue(ctx, desc.value, null);
	      } else {
	        str = formatValue(ctx, desc.value, recurseTimes - 1);
	      }
	      if (str.indexOf('\n') > -1) {
	        if (array) {
	          str = str.split('\n').map(function(line) {
	            return '  ' + line;
	          }).join('\n').substr(2);
	        } else {
	          str = '\n' + str.split('\n').map(function(line) {
	            return '   ' + line;
	          }).join('\n');
	        }
	      }
	    } else {
	      str = ctx.stylize('[Circular]', 'special');
	    }
	  }
	  if (isUndefined(name)) {
	    if (array && key.match(/^\d+$/)) {
	      return str;
	    }
	    name = JSON.stringify('' + key);
	    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
	      name = name.substr(1, name.length - 2);
	      name = ctx.stylize(name, 'name');
	    } else {
	      name = name.replace(/'/g, "\\'")
	                 .replace(/\\"/g, '"')
	                 .replace(/(^"|"$)/g, "'");
	      name = ctx.stylize(name, 'string');
	    }
	  }

	  return name + ': ' + str;
	}


	function reduceToSingleString(output, base, braces) {
	  var numLinesEst = 0;
	  var length = output.reduce(function(prev, cur) {
	    numLinesEst++;
	    if (cur.indexOf('\n') >= 0) numLinesEst++;
	    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
	  }, 0);

	  if (length > 60) {
	    return braces[0] +
	           (base === '' ? '' : base + '\n ') +
	           ' ' +
	           output.join(',\n  ') +
	           ' ' +
	           braces[1];
	  }

	  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
	}


	// NOTE: These type checking functions intentionally don't use `instanceof`
	// because it is fragile and can be easily faked with `Object.create()`.
	function isArray(ar) {
	  return Array.isArray(ar);
	}
	exports.isArray = isArray;

	function isBoolean(arg) {
	  return typeof arg === 'boolean';
	}
	exports.isBoolean = isBoolean;

	function isNull(arg) {
	  return arg === null;
	}
	exports.isNull = isNull;

	function isNullOrUndefined(arg) {
	  return arg == null;
	}
	exports.isNullOrUndefined = isNullOrUndefined;

	function isNumber(arg) {
	  return typeof arg === 'number';
	}
	exports.isNumber = isNumber;

	function isString(arg) {
	  return typeof arg === 'string';
	}
	exports.isString = isString;

	function isSymbol(arg) {
	  return typeof arg === 'symbol';
	}
	exports.isSymbol = isSymbol;

	function isUndefined(arg) {
	  return arg === void 0;
	}
	exports.isUndefined = isUndefined;

	function isRegExp(re) {
	  return isObject(re) && objectToString(re) === '[object RegExp]';
	}
	exports.isRegExp = isRegExp;

	function isObject(arg) {
	  return typeof arg === 'object' && arg !== null;
	}
	exports.isObject = isObject;

	function isDate(d) {
	  return isObject(d) && objectToString(d) === '[object Date]';
	}
	exports.isDate = isDate;

	function isError(e) {
	  return isObject(e) &&
	      (objectToString(e) === '[object Error]' || e instanceof Error);
	}
	exports.isError = isError;

	function isFunction(arg) {
	  return typeof arg === 'function';
	}
	exports.isFunction = isFunction;

	function isPrimitive(arg) {
	  return arg === null ||
	         typeof arg === 'boolean' ||
	         typeof arg === 'number' ||
	         typeof arg === 'string' ||
	         typeof arg === 'symbol' ||  // ES6 symbol
	         typeof arg === 'undefined';
	}
	exports.isPrimitive = isPrimitive;

	exports.isBuffer = __webpack_require__(132);

	function objectToString(o) {
	  return Object.prototype.toString.call(o);
	}


	function pad(n) {
	  return n < 10 ? '0' + n.toString(10) : n.toString(10);
	}


	var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
	              'Oct', 'Nov', 'Dec'];

	// 26 Feb 16:19:34
	function timestamp() {
	  var d = new Date();
	  var time = [pad(d.getHours()),
	              pad(d.getMinutes()),
	              pad(d.getSeconds())].join(':');
	  return [d.getDate(), months[d.getMonth()], time].join(' ');
	}


	// log is just a thin wrapper to console.log that prepends a timestamp
	exports.log = function() {
	  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
	};


	/**
	 * Inherit the prototype methods from one constructor into another.
	 *
	 * The Function.prototype.inherits from lang.js rewritten as a standalone
	 * function (not on Function.prototype). NOTE: If this file is to be loaded
	 * during bootstrapping this function needs to be rewritten using some native
	 * functions as prototype setup using normal JavaScript does not work as
	 * expected during bootstrapping (see mirror.js in r114903).
	 *
	 * @param {function} ctor Constructor function which needs to inherit the
	 *     prototype.
	 * @param {function} superCtor Constructor function to inherit prototype from.
	 */
	exports.inherits = __webpack_require__(114);

	exports._extend = function(origin, add) {
	  // Don't do anything if add isn't an object
	  if (!add || !isObject(add)) return origin;

	  var keys = Object.keys(add);
	  var i = keys.length;
	  while (i--) {
	    origin[keys[i]] = add[keys[i]];
	  }
	  return origin;
	};

	function hasOwnProperty(obj, prop) {
	  return Object.prototype.hasOwnProperty.call(obj, prop);
	}
	
	/* WEBPACK VAR INJECTION */}.call(exports, (function() { return this; }()), __webpack_require__(113)))

/***/ },
/* 123 */
/***/ function(module, exports, __webpack_require__) {

	/*global Image*/
	'use strict';

	var $ = __webpack_require__(3);
	var _ = __webpack_require__(5);

	__webpack_require__(124);


	function cleanupImageLoader(imageLoader) {
		imageLoader.onload = imageLoader.onerror = imageLoader.onabort = null;
	}

	/**
	 * @see https://stereochro.me/ideas/detecting-broken-images-js
	 */
	function isImageOk(img) {
		// During the onload event, IE correctly identifies any images that
		// weren’t downloaded as not complete. Others should too. Gecko-based
		// browsers act like NS4 in that they report this incorrectly.
		if (!img.complete) {
		    return false;
		}

		// However, they do have two very useful properties: naturalWidth and
		// naturalHeight. These give the true size of the image. If it failed
		// to load, either of these should be zero.

		if (typeof img.naturalWidth !== "undefined" && img.naturalWidth === 0) {
		    return false;
		}

		// No other way of checking: assume it’s ok.
		return true;
	}


	function ImageVisualizer(locator, options, dataUrl) {
		var _this = this;
		
		_this._dataStore = locator.getDataStore();
		
		_this._dataUrl = dataUrl;
		
		_this._options = _.extend({
			header_text: '',
			empty_text: ''
		}, options);
		
		var blockCssClass = 'knsh-image-visualizer';
		var additionalCssClasses = ' ' + __webpack_require__(120)(_this._options.css_classes);
		
		var $el = _this.$el = $('<div class="' + blockCssClass + additionalCssClasses + '">' +
			'<div class="' + blockCssClass + '__header"></div>' +
			'<div class="' + blockCssClass + '__wrapper">' +
				'<div class="' + blockCssClass + '__content">' +
					'<div class="' + blockCssClass + '__empty">' +
						_this._options.empty_text +
					'</div>' +
					'<img class="' + blockCssClass + '__image" />' +
				'</div>' +
			'</div>' +
		'</div>');
		
		_this.$header = $el.find('.' + blockCssClass + '__header');
		_this.$empty = $el.find('.' + blockCssClass + '__empty');
		_this.$image = $el.find('.' + blockCssClass + '__image');
		
		_this.$image.hide().css({
			visibility: 'hidden'
		});
		
		_this._imageLoader = null;
	}
	__webpack_require__(107)(ImageVisualizer.prototype, 'ImageVisualizer');
	_.extend(ImageVisualizer.prototype, {
		componentDidMount: function () {
			var _this = this;
			
			_this.$header.text( _this._options.header_text );
			
			_this._renderData();
			
			_this._dataStore.on('data-updated', _this._dataUpdatedListener = function (args) {
				if (!args || !args.dataUrl || args.dataUrl === _this._dataUrl) {
					_this._renderData();
				}
			});
		},
		
		componentWillUnmount: function () {
			var _this = this;
			
			_this._dataStore.removeListener('data-updated', _this._dataUpdatedListener);
			_this._dataUpdatedListener = null;
			
			_this.$image.hide().css({
				visibility: 'hidden'
			});
			_this.$image.prop('src', '');
			_this.$empty.show();
			_this.$header.empty();
		},
		
		_renderData: function () {
			var _this = this;
			
			var seriesData = _this._dataStore.getData(_this._dataUrl);
			
			if (seriesData && seriesData.length) {
				var data = seriesData[seriesData.length-1];
				
				_this._loadImage(data.y);
			}
		},
		
		_loadImage: function (imageUrl) {
			var _this = this;
			
			if (_this._imageLoader) {
				cleanupImageLoader(_this._imageLoader);
				_this._imageLoader = null;
			}
			
			if (!imageUrl) {
				_this.$image.css({
					visibility: 'hidden'
				});
				_this.$empty.show();
				return;
			}
			
			var imageLoader = _this._imageLoader = new Image();
			
			imageLoader.onload = function () {
				cleanupImageLoader(imageLoader);
				
				if (_this._imageLoader === imageLoader && isImageOk(imageLoader)) {
					_this.$empty.hide();
					_this.$image.prop('src', imageLoader.src);
					_this.$image.show().css({
						visibility: ''
					});
				}
			};
			
			imageLoader.onerror = imageLoader.onabort = function () {
				cleanupImageLoader(imageLoader);
				
				if (_this._imageLoader === imageLoader) {
					_this.$image.css({
						visibility: 'hidden'
					});
					_this.$empty.show();
				}
			};
			
			imageLoader.src = imageUrl;
		}
	});

	module.exports = ImageVisualizer;


/***/ },
/* 124 */
/***/ function(module, exports, __webpack_require__) {

	// style-loader: Adds some css to the DOM by adding a <style> tag

	// load the styles
	var content = __webpack_require__(125);
	if(typeof content === 'string') content = [[module.id, content, '']];
	// add the styles to the DOM
	var update = __webpack_require__(9)(content, {});
	// Hot Module Replacement
	if(false) {
		// When the styles change, update the <style> tags
		module.hot.accept("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/visualizers/image-visualizer.less", function() {
			var newContent = require("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/visualizers/image-visualizer.less");
			if(typeof newContent === 'string') newContent = [[module.id, newContent, '']];
			update(newContent);
		});
		// When the module is disposed, remove the <style> tags
		module.hot.dispose(function() { update(); });
	}

/***/ },
/* 125 */
/***/ function(module, exports, __webpack_require__) {

	exports = module.exports = __webpack_require__(11)();
	exports.push([module.id, ".knsh-image-visualizer {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n  width: 100%;\n  height: 100%;\n}\n.knsh-image-visualizer__header {\n  padding: 10px 10px 6px;\n}\n.knsh-image-visualizer__wrapper {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  display: table;\n  width: 100%;\n  min-height: 100px;\n  padding: 0 10px 10px 10px;\n}\n.knsh-image-visualizer__content {\n  display: table-cell;\n  vertical-align: middle;\n  text-align: center;\n}\n.knsh-image-visualizer__image {\n  max-width: 100%;\n  border: 0 none;\n}\n.knsh-image-visualizer__empty {\n  color: #d8d8d8;\n  font-style: italic;\n}\n", ""]);

/***/ },
/* 126 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var $ = __webpack_require__(3);
	var _ = __webpack_require__(5);

	var Rickshaw = __webpack_require__(2);
	var moment = __webpack_require__(6);

	__webpack_require__(127);


	function PlotVisualizer(locator, options, dataUrl) {
		var _this = this;
		
		_this._locator = locator;
		
		_this._layoutStore = _this._locator.getLayoutStore();
		_this._dataStore = _this._locator.getDataStore();
		
		_this._dataUrl = dataUrl;
		
		_this._options = _.extend({
			header_text: '',
			renderer: 'lineplot',
			color: 'rgba(0,0,0,1)',
			interpolation: 'none',
			min: undefined,
			max: undefined,
			time_interval: null,
			tick_count: 5,
			tick_format: 'HH:mm:ss'
		}, options);
		
		_this._data = [];
		
		_this._plotWidth = 0;
		_this._plotHeight = 0;
		
		var blockCssClass = 'knsh-plot-visualizer';
		var additionalCssClasses = ' ' + __webpack_require__(120)(_this._options.css_classes);
		
		var $el = _this.$el = $('<div class="' + blockCssClass + additionalCssClasses + '">' +
			'<div class="' + blockCssClass + '__header"></div>' +
			'<div class="' + blockCssClass + '__plot-wrapper">' +
				'<div class="' + blockCssClass + '__plot"></div>' +
			'</div>' +
		'</div>');
		
		_this.$header = $el.find('.' + blockCssClass + '__header');
		_this.$plotWrapper = $el.find('.' + blockCssClass + '__plot-wrapper');
		_this.$plot = $el.find('.' + blockCssClass + '__plot');
	}
	__webpack_require__(107)(PlotVisualizer.prototype, 'PlotVisualizer');
	_.extend(PlotVisualizer.prototype, {
		componentDidMount: function () {
			var _this = this;
			
			_this.$header.text( _this._options.header_text );
			
			var graph = _this._graph = new Rickshaw.Graph({
				element: _this.$plot[0],
				width: _this.$plot.width(),
				height: _this.$plot.height(),
				renderer: _this._options.renderer,
				preserve: true,
				series: [
					{
						color: _this._options.color,
						data: _this._data
					}
				],
				min: _this._options.min,
				max: _this._options.max,
				interpolation: _this._options.interpolation
			});
			
			var ticksTreatment = 'glow';
			
			var xAxisTimeUnit = _this._xAxisTimeUnit = {
				seconds: _this._getTimeTickInterval(),
				formatter: function (d) {
					return moment(d).format(_this._options.tick_format);
				}
			};
			
			var xAxis = _this._xAxis = new Rickshaw.Graph.Axis.Time({
				graph: graph,
				ticksTreatment: ticksTreatment,
				timeUnit: xAxisTimeUnit
			});
			
			var yAxis = _this._yAxis = new Rickshaw.Graph.Axis.Y({
				graph: graph,
				tickFormat: Rickshaw.Fixtures.Number.formatKMBT,
				ticksTreatment: ticksTreatment
			});
			
			_this._updateSize();
			_this._renderPlot();
			_this._renderData();
			
			_this._layoutStore.on('layout-resized', _this._layoutResizedListener = function () {
				_this._updateSize();
				_this._renderPlot();
			});
			
			_this._dataStore.on('data-updated', _this._dataUpdatedListener = function (args) {
				if (!args || !args.dataUrl || args.dataUrl === _this._dataUrl) {
					_this._renderData();
				}
			});
		},
		
		componentWillUnmount: function () {
			var _this = this;
			
			_this._layoutStore.removeListener('layout-resized', _this._layoutResizedListener);
			_this._layoutResizedListener = null;
			
			_this._dataStore.removeListener('data-updated', _this._dataUpdatedListener);
			_this._dataUpdatedListener = null;
			
			_this.$plot.empty();
			_this.$header.empty();
			
			_this._graph = null;
			_this._xAxis = null;
			_this._xAxisTimeUnit = null;
			_this._yAxis = null;
		},
		
		_renderPlot: function () {
			var _this = this;
			
			_this._renderTimeTicks();
			
			_this._graph.render();
			_this._xAxis.render();
			_this._yAxis.render();
		},
		
		_updateSize: function () {
			var _this = this;
			
			var $plotWrapper = _this.$plotWrapper;
			var $plot = _this.$plot;
			
			$plot.hide();
			
			_this._plotWidth = $plotWrapper.width();
			_this._plotHeight = $plotWrapper.height();
			
			_this._graph.configure({
				width: _this._plotWidth,
				height: _this._plotHeight
			});
			
			$plot.show();
		},
		
		_renderData: function () {
			var _this = this;
			
			var seriesData = _this._dataStore.getData(_this._dataUrl);
			
			if (seriesData) {
				var plotData = _this._data;
				
				var selectedData = [],
					ic = seriesData.length,
					i = ic-1,
					timeInterval = _this._options.time_interval;
				
				// Add new data:
				while (i >= 0) {
					// Push backwards to concat later:
					selectedData.unshift({ x: seriesData[i].x, y: seriesData[i].y });
					
					// Add until we get enough points to fill the required time interval:
					if (typeof timeInterval === 'number' && (selectedData[selectedData.length-1].x - selectedData[0].x) > timeInterval) {
						break;
					}
					
					--i;
				}
				
				// Note: Update chart data in-place because our graph has a reference to it:
				plotData.splice.apply(plotData, [ 0, plotData.length ].concat(selectedData));
				
				_this._stubData();
				
				// Convert to seconds (Rickshaw requires this time format):
				plotData.forEach(function (point) {
					point.x /= 1000;
				});
				
				_this._renderTimeTicks();
				
				_this._graph.render();
			}
		},
		
		_getTimeTickInterval: function () {
			var _this = this;
			
			var plotData = _this._data;
			
			var timeIntervalDefault = 10 * 1000;
			
			var timeInterval = (typeof _this._options.time_interval === 'number'
				? _this._options.time_interval
				: (plotData.length >= 2
					? ((plotData[plotData.length-1].x - plotData[0].x) * 1000)
					: timeIntervalDefault
				)
			);
			
			var tickCount = _this._options.tick_count;
			
			// HACK: If the space between ticks is too small, let there be one tick per plot.
			var minWidthBetweenTicksInPixels = 70;
			if (
				_this._plotWidth > 0 &&
				(_this._plotWidth / tickCount) < minWidthBetweenTicksInPixels
			) {
				tickCount = 1;
			}
			
			var chartTickInterval = Math.ceil((timeInterval / 1000) / tickCount);
			
			return chartTickInterval;
		},
		
		_renderTimeTicks: function () {
			var _this = this,
				chartTickInterval;
			
			if (_this._xAxisTimeUnit) {
				chartTickInterval = _this._getTimeTickInterval();
				if (chartTickInterval !== _this._xAxisTimeUnit.seconds) {
					_this._xAxisTimeUnit.seconds = chartTickInterval;
					
					if (_this._xAxis) {
						_this._xAxis.render();
					}
				}
			}
		},
		
		_stubData: function () {
			var _this = this;
			
			var plotData = _this._data;
			var timeInterval = _this._options.time_interval;
			
			// WARNING: Assuming a time-based data that comes each second,
			// so we stub each second back until we fill the whole time interval.
			
			// TODO: Remove the stubbing when proper backend with historical data is ready.
			
			var nowX = (new Date()).getTime();
			
			if (plotData.length <= 0) {
				plotData.push({
					x: nowX,
					y: 0,
					stub: true
				});
			}
			
			while ((plotData[plotData.length-1].x - plotData[0].x) <= timeInterval) {
				plotData.unshift({
					x: plotData[0].x - 1000,
					y: 0,
					stub: true
				});
			}
		}
	});

	module.exports = PlotVisualizer;


/***/ },
/* 127 */
/***/ function(module, exports, __webpack_require__) {

	// style-loader: Adds some css to the DOM by adding a <style> tag

	// load the styles
	var content = __webpack_require__(128);
	if(typeof content === 'string') content = [[module.id, content, '']];
	// add the styles to the DOM
	var update = __webpack_require__(9)(content, {});
	// Hot Module Replacement
	if(false) {
		// When the styles change, update the <style> tags
		module.hot.accept("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/visualizers/plot-visualizer.less", function() {
			var newContent = require("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/visualizers/plot-visualizer.less");
			if(typeof newContent === 'string') newContent = [[module.id, newContent, '']];
			update(newContent);
		});
		// When the module is disposed, remove the <style> tags
		module.hot.dispose(function() { update(); });
	}

/***/ },
/* 128 */
/***/ function(module, exports, __webpack_require__) {

	exports = module.exports = __webpack_require__(11)();
	exports.push([module.id, ".knsh-plot-visualizer {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n  width: 100%;\n  height: 100%;\n}\n.knsh-plot-visualizer__header {\n  padding: 10px 10px 6px;\n}\n.knsh-plot-visualizer__plot-wrapper {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  min-height: 200px;\n  padding: 10px;\n}\n.knsh-plot-visualizer__plot {\n  overflow: hidden;\n  background: rgba(0, 150, 255, 0.1);\n  border: 1px solid #d8d8d8;\n}\n", ""]);

/***/ },
/* 129 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var $ = __webpack_require__(3);
	var _ = __webpack_require__(5);

	__webpack_require__(130);


	function ValueVisualizer(locator, options, dataUrl) {
		var _this = this;
		
		_this._dataStore = locator.getDataStore();
		
		_this._dataUrl = dataUrl;
		
		_this._options = _.extend({
			header_text: '',
			min: 0.0,
			max: 1.0,
			fraction_digits: 4,
			higher_is_better: false
		}, options);
		
		var blockCssClass = 'knsh-value-visualizer';
		var additionalCssClasses = ' ' + __webpack_require__(120)(_this._options.css_classes);
		
		var $el = _this.$el = $('<div class="' + blockCssClass + additionalCssClasses + '">' +
			'<div class="' + blockCssClass + '__header"></div>' +
			'<div class="' + blockCssClass + '__wrapper">' +
				'<div class="' + blockCssClass + '__figure"></div>' +
			'</div>' +
		'</div>');
		
		_this.$header = $el.find('.' + blockCssClass + '__header');
		_this.$figure = $el.find('.' + blockCssClass + '__figure');
	}
	__webpack_require__(107)(ValueVisualizer.prototype, 'ValueVisualizer');
	_.extend(ValueVisualizer.prototype, {
		componentDidMount: function () {
			var _this = this;
			
			_this.$header.text( _this._options.header_text );
			
			_this._renderData();
			
			_this._dataStore.on('data-updated', _this._dataUpdatedListener = function (args) {
				if (!args || !args.dataUrl || args.dataUrl === _this._dataUrl) {
					_this._renderData();
				}
			});
		},
		
		componentWillUnmount: function () {
			var _this = this;
			
			_this._dataStore.removeListener('data-updated', _this._dataUpdatedListener);
			_this._dataUpdatedListener = null;
			
			_this.$figure.empty();
			_this.$header.empty();
		},
		
		_renderData: function () {
			var _this = this;
			
			var seriesData = _this._dataStore.getData(_this._dataUrl);
			
			if (seriesData && seriesData.length) {
				var data = seriesData[seriesData.length-1];
				
				_this.$figure.text( _this._formatValue(data.y) );
				
				_this.$figure.css({
					color: _this._getValueColor(data.y)
				});
			}
		},
		
		_formatValue: function (value) {
			var _this = this;
			
			return value.toFixed(_this._options.fraction_digits);
		},
		
		_getValueColor: function (value) {
			var _this = this,
				r = 0,
				g = 0,
				b = 0;
			
			value = ((value - _this._options.min) / (_this._options.max - _this._options.min));
			
			// Default is to display low values as good ones (green), invert if opposite:
			if (_this._options.higher_is_better) {
				value = (1.0 - value);
			}
			
			// Simple red-to-green gradient:
			r = Math.round(value * 255);
			g = Math.round((1.0 - value) * 255);
			
			return 'rgb(' + r + ',' + g + ',' + b + ')';
		}
	});

	module.exports = ValueVisualizer;


/***/ },
/* 130 */
/***/ function(module, exports, __webpack_require__) {

	// style-loader: Adds some css to the DOM by adding a <style> tag

	// load the styles
	var content = __webpack_require__(131);
	if(typeof content === 'string') content = [[module.id, content, '']];
	// add the styles to the DOM
	var update = __webpack_require__(9)(content, {});
	// Hot Module Replacement
	if(false) {
		// When the styles change, update the <style> tags
		module.hot.accept("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/visualizers/value-visualizer.less", function() {
			var newContent = require("!!/home/dima/github/dkorolev/Web/node_modules/css-loader/index.js!/home/dima/github/dkorolev/Web/node_modules/less-loader/index.js!/home/dima/github/dkorolev/Web/src/frontend/visualizers/value-visualizer.less");
			if(typeof newContent === 'string') newContent = [[module.id, newContent, '']];
			update(newContent);
		});
		// When the module is disposed, remove the <style> tags
		module.hot.dispose(function() { update(); });
	}

/***/ },
/* 131 */
/***/ function(module, exports, __webpack_require__) {

	exports = module.exports = __webpack_require__(11)();
	exports.push([module.id, ".knsh-value-visualizer {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n  width: 100%;\n  height: 100%;\n}\n.knsh-value-visualizer__header {\n  padding: 10px 10px 6px;\n}\n.knsh-value-visualizer__wrapper {\n  -webkit-box-sizing: border-box;\n  -moz-box-sizing: border-box;\n  box-sizing: border-box;\n  min-height: 100px;\n  padding: 0 10px 10px 10px;\n}\n.knsh-value-visualizer__figure {\n  padding: 10px 0 0 0;\n  color: #000000;\n  font-size: 40px;\n  border-top: 1px solid #d8d8d8;\n}\n", ""]);

/***/ },
/* 132 */
/***/ function(module, exports, __webpack_require__) {

	module.exports = function isBuffer(arg) {
	  return arg && typeof arg === 'object'
	    && typeof arg.copy === 'function'
	    && typeof arg.fill === 'function'
	    && typeof arg.readUInt8 === 'function';
	}

/***/ }
]);
