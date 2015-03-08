/*******************************************************************************
The MIT License (MIT)

Copyright (c) 2015 Dmitry "Dima" Korolev <dmitry.korolev@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*******************************************************************************/

#include "../Bricks/port.h"

#include "db/db.h"

#include "../Bricks/file/file.h"
#include "../Bricks/strings/util.h"
#include "../Bricks/time/chrono.h"
#include "../Bricks/net/api/api.h"
#include "../Bricks/dflags/dflags.h"

DEFINE_int32(port, 3000, "Local port to use.");

using bricks::FileSystem;
using bricks::strings::Printf;
using bricks::time::Now;

class ServeRawPubSubOverHTTP {
 public:
  ServeRawPubSubOverHTTP(Request r)
      : http_request_scope_(std::move(r)), http_response_(http_request_scope_.SendChunkedResponse()) {}

  inline bool Entry(const std::unique_ptr<db::Record>& entry) {
    try {
      http_response_(JSON(entry, "record") + "\n");  // WTF do I need to say `JSON` here? -- D.K.
      return true;
    } catch (const bricks::net::NetworkException&) {
      return false;
    }
  }

  inline void Terminate() { http_response_("{\"error\":\"Done.\"}\n"); }

 private:
  Request http_request_scope_;  // Need to keep `Request` in scope, for the lifetime of the chunked response.
  bricks::net::HTTPServerConnection::ChunkedResponseSender http_response_;

  ServeRawPubSubOverHTTP() = delete;
  ServeRawPubSubOverHTTP(const ServeRawPubSubOverHTTP&) = delete;
  void operator=(const ServeRawPubSubOverHTTP&) = delete;
  ServeRawPubSubOverHTTP(ServeRawPubSubOverHTTP&&) = delete;
  void operator=(ServeRawPubSubOverHTTP&&) = delete;
};

class Cruncher {
 public:
  Cruncher(const std::string& name) : name_(name) {}

  inline bool Entry(const std::unique_ptr<db::Record>& entry) {
    std::cerr << '@' << name_ << " : " << JSON(entry, "record") << '\n';
    return true;
  }

  inline void Terminate() { std::cerr << '@' << name_ << " is done.\n"; }

 private:
  const std::string& name_;

  Cruncher() = delete;
  Cruncher(const Cruncher&) = delete;
  void operator=(const Cruncher&) = delete;
  Cruncher(Cruncher&&) = delete;
  void operator=(Cruncher&&) = delete;
};

struct Controller {
 public:
  explicit Controller(int port, const std::string& name, db::AgreeDisagreeStorage* db)
      : port_(port),
        name_(name),
        db_(db),
        cruncher_(name_),
        cruncher_subscription_scope_(db_->Subscribe(cruncher_)),
        controller_boilerplate_html_(
            FileSystem::ReadFileAsString(FileSystem::JoinPath("static", "controller_example.html"))) {
    // The main controller page.
    HTTP(port_)
        .Register("/" + name_ + "/actions", std::bind(&Controller::Actions, this, std::placeholders::_1));
    // Raw PubSub as JSON.
    HTTP(port_).Register("/" + name_ + "/raw", [this](Request r) {
      db_->Subscribe(new ServeRawPubSubOverHTTP(std::move(r))).Detach();
    });
  }

  void Actions(Request r) { r(Printf(controller_boilerplate_html_.c_str()), HTTPResponseCode.OK, "text/html"); }

 private:
  const int port_;
  const std::string name_;

  db::AgreeDisagreeStorage* db_;
  Cruncher cruncher_;
  typename sherlock::StreamInstanceImpl<std::unique_ptr<db::Record>>::template ListenerScope<Cruncher>
      cruncher_subscription_scope_;

  const std::string controller_boilerplate_html_;

  Controller() = delete;
};

int main() {
  const int port = FLAGS_port;

  // Create and redirect to a new demo when POST-ed onto `/new`.
  HTTP(port).Register("/new", [&port](Request r) {
    if (r.method == "POST") {
      uint64_t salt = static_cast<uint64_t>(Now());
      // Randomly generated name w/o safety checking. -- D.K.
      std::string name = "";
      for (size_t i = 0; i < 5; ++i) {
        name += ('a' + (salt % 26));
        salt /= 26;
      }
      auto demo = new db::AgreeDisagreeStorage(port, name);  // Lives forever. -- D.K.
      auto controller = new Controller(port, name, demo);    // Lives forever. -- D.K.
      static_cast<void>(controller);
      r("", HTTPResponseCode.Found, "text/html", HTTPHeaders({{"Location", "/" + name + "/actions"}}));
    } else {
      r(bricks::net::DefaultMethodNotAllowedMessage(), HTTPResponseCode.MethodNotAllowed, "text/html");
    }
  });

  // Landing page.
  const std::string dir = "static/";
  HTTP(port).ServeStaticFilesFrom(dir, "/static/");
  HTTP(port).Register(
      "/",
      new bricks::net::api::StaticFileServer(
          bricks::FileSystem::ReadFileAsString(FileSystem::JoinPath(dir, "index.html")), "text/html"));

  // Run forever.
  HTTP(port).Join();
}
