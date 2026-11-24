"use strict";

const show = require ("../more/show");

// ::types ./Body

// What a route handler decides: redirect, render a view, or send a body.
/* Response ::
                Redirect Number String |
                Render String (Object String Any) |
                Send Number (Object String Any) (Body a)
*/
function Response() {
  throw new TypeError ("Response is abstract: use Response.Redirect, Response.Render or Response.Send");
}

// Redirect :: (Number, String) -> Response a
function Redirect(status, location) {
  // Response#status :: Number
  this.status = status;
  // Response#url :: String
  this.url = location;
}

// Render :: (String, Object String Any) -> Response a
function Render(template, locals) {
  // Response#view :: String
  this.view = template;
  // Response#options :: Object String Any
  this.options = locals;
}

// Send :: (Number, Object String Any, Body a) -> Response a
function Send(status, headers, body) {
  this.status = status;
  // Response#headers :: Object String Any
  this.headers = headers;
  // Response#body :: Body a
  this.body = body;
}

// Redirect# :: Response
Redirect.prototype = Object.create (Response.prototype);

// Render# :: Response
Render.prototype = Object.create (Response.prototype);

// Send# :: Response
Send.prototype = Object.create (Response.prototype);

// redirect :: Number -> String -> Response a
function redirect(status) {
  return location => new Redirect (status, location);
}

// render :: String -> Object String Any -> Response a
function render(template) {
  return locals => new Render (template, locals);
}

// send :: Number -> Object String Any -> Body a -> Response a
function send(status) {
  return headers => body => new Send (status, headers, body);
}

// redirect.name :: String
Object.defineProperty (redirect, "name", { value: "Redirect" });

// render.name :: String
Object.defineProperty (render, "name", { value: "Render" });

// send.name :: String
Object.defineProperty (send, "name", { value: "Send" });

Response.Redirect = redirect;
Response.Render = render;
Response.Send = send;

// Response#@@type :: String
Redirect.prototype["@@type"] = "Response";
Render.prototype["@@type"] = "Response";
Send.prototype["@@type"] = "Response";

// Response#@@tag :: String
Redirect.prototype["@@tag"] = "Redirect";
Render.prototype["@@tag"] = "Render";
Send.prototype["@@tag"] = "Send";

// ::narrow Redirect
// Response#isRedirect :: Boolean
Redirect.prototype.isRedirect = true;
Render.prototype.isRedirect = false;
Send.prototype.isRedirect = false;

// ::narrow Render
// Response#isRender :: Boolean
Redirect.prototype.isRender = false;
Render.prototype.isRender = true;
Send.prototype.isRender = false;

// ::narrow Send
// Response#isSend :: Boolean
Redirect.prototype.isSend = false;
Render.prototype.isSend = false;
Send.prototype.isSend = true;

/* Response#matchWith :: Response a ~> {
  Redirect :: Number -> String -> b,
  Render :: String -> Object String Any -> b,
  Send :: Number -> Object String Any -> Body a -> b
} -> b */
Redirect.prototype.matchWith = function (cases) {
  return cases.Redirect (this.status) (this.url);
};

Render.prototype.matchWith = function (cases) {
  return cases.Render (this.view) (this.options);
};

Send.prototype.matchWith = function (cases) {
  return cases.Send (this.status) (this.headers) (this.body);
};

// Response#show :: Response a ~> () -> String
Redirect.prototype.show = function () {
  return "Redirect (" + show (this.status) + ") (" + show (this.url) + ")";
};

Render.prototype.show = function () {
  return "Render (" + show (this.view) + ") (" + show (this.options) + ")";
};

Send.prototype.show = function () {
  return "Send (" + show (this.status) + ") (" + show (this.headers) + ") (" + show (this.body) + ")";
};

module.exports = Response;
