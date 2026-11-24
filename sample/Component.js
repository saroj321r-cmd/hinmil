// ::ignore
import daggy from 'daggy'

// Handler :: (req, res) -> res

// Component :: Setting String a | Plugin String Handler | Route String c Handler | Engine String d | Locals a
// Component.Setting :: (String, a) -> Component a c d
// Component.Plugin  :: (String, b) -> Component a c d
// Component.Route   :: (String, c, b) -> Component a c d
// Component.Engine  :: (String, d) -> Component a c d
// Component.Locals  :: a -> Component a c d
/* Component#cata :: Component a c d ~> ({ 
      Setting :: ((String,  a) -> r), 
      Plugin :: ((String, Handler) -> r), 
      Route :: ((String, c, Handler) -> r),
      Engine :: ((String, d) -> r), 
      Locals :: (a -> r) }) -> r */

const Component = daggy.taggedSum('Component', {
  Setting: ['name', 'value'],
  Plugin:  ['path', 'handler'],
  Route:   ['method', 'spec', 'handler'],
  Engine:  ['extension', 'engine'],
  Locals:  ['value']
})

const setting = Component.Setting('port', 3000)
const plugin  = Component.Plugin('auth', x => x)
const route   = Component.Route('GET', '/users', req => req)
const engine  = Component.Engine('.html', { render: t => t })
const locals  = Component.Locals({ title: 'App' })

// handleComponent :: Component a c d -> String | a
function handleComponent(component) {
  return component.cata({
    Setting: (name, value) => value,
    Plugin:  (path, handler) => `Plugin ${path}`,
    Route:   (method, spec, handler) => `${method} ${spec}`,
    Engine:  (ext, engine) => `Engine ${ext}`,
    Locals:  (value) => `Locals`
  })
}

// num :: Number
const num = handleComponent(setting)
