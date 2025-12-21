export const simpleLoggerJs = `
// [WebSim] Logger Polyfill - Global Script
(function() {
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;

  function post(level, args) {
    try {
      const msgPreview = args.map(String).join(' ');
      if (msgPreview.includes('AudioContext') || msgPreview.includes('acknowledgeRemotionLicense')) return;

      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']';
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch(e) { return '[Circular]'; }
        }
        return String(a);
      });
      
      if (window.parent) {
          window.parent.postMessage(JSON.stringify({ type: 'console', level, args: serialized }), '*');
      }
    } catch(e) {}
  }

  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught]', e.message]);
  });
})();
`;

export const websimSocketPolyfill = `
// [WebSim] Generic DB & Bridge Polyfill (PostMessage Version)
(function() {
    window._genericDB = {};
    window._subscribers = {};
    window._currentUser = null;
    
    // Listen for messages from Devvit Host
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'init_response') {
            console.log('[Bridge] Received Init Data');
            if (msg.dbData) {
                window._genericDB = msg.dbData;
                window._currentUser = msg.user;
                
                if (window.WebsimSocket && window.WebsimSocket.updateIdentity && msg.user) {
                    window.WebsimSocket.updateIdentity(msg.user);
                }
                
                const readyEvent = new CustomEvent('GAMEDATA_READY', { detail: msg.dbData });
                window.dispatchEvent(readyEvent);
                
                Object.keys(window._subscribers).forEach(col => {
                    DevvitBridge.notifySubscribers(col);
                });
            }
        }
        
        if (msg.type === 'load_response') {
             // Handle async load response if needed, for now we rely on optimistic updates and init
        }
    });

    const DevvitBridge = {
        init: () => {
            console.log("[Bridge] Requesting Init...");
            window.parent.postMessage({ type: 'init' }, '*');
        },
        notifySubscribers: (collection) => {
            if (window._subscribers[collection]) {
                const list = Object.values(window._genericDB[collection] || {});
                list.sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
                window._subscribers[collection].forEach(cb => { try { cb(list); } catch(e) {} });
            }
        }
    };

    window.GenericDB = {
        save: async (collection, key, value) => {
            if (!window._genericDB[collection]) window._genericDB[collection] = {};
            window._genericDB[collection][key] = value;
            DevvitBridge.notifySubscribers(collection);
            
            // Send to Host
            window.parent.postMessage({ type: 'save', collection, key, value }, '*');
        },
        get: (collection, key) => window._genericDB[collection]?.[key] || null,
        getAll: (collection) => window._genericDB[collection] || {},
        fetchFromServer: async (collection, key) => {
             // This is harder with postMessage as it's not request-response in the same tick.
             // We fallback to local cache which should be populated by Init.
             return window._genericDB[collection]?.[key] || null;
        },
        delete: async (collection, key) => {
             if (window._genericDB[collection]) delete window._genericDB[collection][key];
             DevvitBridge.notifySubscribers(collection);
             // TODO: Add delete support in server if needed
        },
        subscribe: (collection, callback) => {
            if (!window._subscribers[collection]) window._subscribers[collection] = [];
            window._subscribers[collection].push(callback);
            const currentList = Object.values(window._genericDB[collection] || {});
            currentList.sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
            callback(currentList);
            return () => {
                window._subscribers[collection] = window._subscribers[collection].filter(f => f !== callback);
            };
        }
    };

    if (document.readyState === 'complete') {
        setTimeout(DevvitBridge.init, 100);
    } else {
        window.addEventListener('load', () => setTimeout(DevvitBridge.init, 100));
    }

    // ------------------------------------------------------------------------
    // 2. WebSim Adapter (Backward Compatibility)
    // ------------------------------------------------------------------------
    class AdapterCollection {
        constructor(name) { this.name = name; }
        
        getList() { 
            const list = Object.values(window.GenericDB.getAll(this.name));
            return list.sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
        }
        
        async create(data) {
            const id = Math.random().toString(36).substr(2, 12);
            const record = { 
                id, 
                ...data, 
                created_at: new Date().toISOString() 
            };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        async update(id, data) {
            const current = window.GenericDB.get(this.name, id);
            // If not found in cache, we could optionally await fetchFromServer here, 
            // but strict WebSim API is synchronous for getList/etc usually, async for update.
            // For now, assume hydration is complete or we rely on cache.
            if (!current) throw new Error('Record not found or not loaded');
            
            const record = { ...current, ...data };
            window.GenericDB.save(this.name, id, record);
            return record;
        }

        async delete(id) {
             await window.GenericDB.delete(this.name, id);
        }

        subscribe(cb) {
            return window.GenericDB.subscribe(this.name, cb);
        }
        
        filter(criteria) {
             const self = this;
             return {
                 getList: () => self.getList().filter(r => self._matches(r, criteria)),
                 subscribe: (cb) => {
                     const wrapped = (list) => cb(list.filter(r => self._matches(r, criteria)));
                     return self.subscribe(wrapped);
                 }
             };
        }
        _matches(record, criteria) {
            for (let key in criteria) { if (record[key] !== criteria[key]) return false; }
            return true;
        }
    }

    // Mock WebSimSocket Class
    window.WebsimSocket = class WebsimSocket {
        constructor() {
            if (!window.websimSocketInstance) {
                window.websimSocketInstance = { 
                    collection: (name) => new AdapterCollection(name) 
                };
            }
            return window.websimSocketInstance;
        }
        static updateIdentity(user) {
            window._currentUser = user;
        }
    };
    
    // Auto-instantiate if game expects 'party'
    if (!window.party) { 
        window.websimSocketInstance = { 
            collection: (name) => new AdapterCollection(name) 
        };
        window.party = window.websimSocketInstance; 
    }
})();
`;

export const websimStubsJs = `
// [WebSim] API Stubs - Global Script
(function() {
    let _currentUser = null;

    // Listen for identity update from Socket Handshake or direct message
    const updateIdentity = (user) => {
        _currentUser = user;
        if (window.WebsimSocket && window.WebsimSocket.updateIdentity) {
            window.WebsimSocket.updateIdentity(user);
        }
    };

    // Also listen to window messages for 'set_user_context' just in case
    window.addEventListener('message', (e) => {
        let data = e.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) {} }
        if (data && (data.type === 'set_user_context' || (data.payload && data.payload.user))) {
            const user = data.payload.user || data.payload;
            updateIdentity(user);
        }
    });

    if (!window.websim) {
        window.websim = {
            getCurrentUser: async () => {
                // Wait for handshake
                let tries = 0;
                while(!_currentUser && tries < 20) {
                    await new Promise(r => setTimeout(r, 100));
                    tries++;
                }
                return _currentUser || {
                    id: 'guest', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
            },
            getProject: async () => ({ id: 'local', title: 'Reddit Game' }),
            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                return window.websimSocketInstance ? window.websimSocketInstance.collection(name) : {
                    subscribe: () => {}, 
                    getList: () => [], 
                    create: async () => {}, 
                    update: async () => {}, 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: () => {}, getList: () => [] })
                };
            },
            upload: async (blob) => {
                try { return URL.createObjectURL(blob); } catch(e) { return ''; }
            }
        };
    }
})();
`;

export const jsxDevProxy = `
// Shim for react/jsx-dev-runtime to work in production Vite builds
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

export const Fragment = _Fragment;
export const jsx = _jsx;
export const jsxs = _jsxs;

// Proxy jsxDEV to jsx (ignores the extra dev-only arguments)
export const jsxDEV = (type, props, key, isStaticChildren, source, self) => {
  return _jsx(type, props, key);
};
`;

export const websimPackageJs = `
// Bridge for "import websim from 'websim'"
const w = window.websim || {};
export default w;
// Export common methods if destructured
export const getProject = w.getProject;
export const getCurrentUser = w.getCurrentUser;
export const upload = w.upload;
export const collection = w.collection;
`;

