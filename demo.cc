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
#include "../Bricks/rtti/dispatcher.h"
#include "../Bricks/net/api/api.h"
#include "../Bricks/dflags/dflags.h"

DEFINE_int32(port, 3000, "Local port to use.");

using bricks::FileSystem;
using bricks::strings::Printf;
using bricks::time::Now;
using bricks::time::EPOCH_MILLISECONDS;
using bricks::time::MILLISECONDS_INTERVAL;

template <typename Y>
struct VizPoint {
  double x;
  Y y;
  template <typename A>
  void serialize(A& ar) {
    ar(CEREAL_NVP(x), CEREAL_NVP(y));
  }
};

template <typename E>
class ServeRawPubSubOverHTTP {
 public:
  ServeRawPubSubOverHTTP(Request r)
      : http_request_scope_(std::move(r)), http_response_(http_request_scope_.SendChunkedResponse()) {}

  inline bool Entry(const E& entry) {
    try {
      http_response_(entry, "record");
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
  struct types {
    typedef db::Record base;
    typedef std::tuple<db::AnswerRecord, db::QuestionRecord, db::UserRecord> derived_list;
    typedef bricks::rtti::RuntimeTupleDispatcher<base, derived_list> dispatcher;
  };

  struct Box {
    std::vector<std::string> users;
    std::vector<std::string> questions;
    std::map<db::QID, std::map<db::UID, db::ANSWER>> answers;
  };

  Cruncher(int port, const std::string& name)
      : port_(port), name_(name), methronome_thread_(&Cruncher::Methronome, this) {}

  ~Cruncher() { methronome_thread_.join(); }

  // TODO(dkorolev): Move this to a message queue.
  Box GetBox() const { return box_; }

  inline bool Entry(const std::unique_ptr<db::Record>& entry) {
    types::dispatcher::DispatchCall(*entry, *this);
    return true;
  }

  inline void operator()(db::Record&) { throw std::logic_error("Should not happen."); }

  inline void operator()(db::UserRecord& u) {
    std::cerr << '@' << name_ << " +U: " << u.uid << '\n';
    box_.users.push_back(u.uid);
  }

  inline void operator()(db::QuestionRecord& q) {
    std::cerr << '@' << name_ << " +Q" << static_cast<size_t>(q.qid) << " : \"" << q.text << "\"\n";
    box_.questions.push_back(q.text);
  }

  inline void operator()(db::AnswerRecord& a) {
    std::cerr << '@' << name_ << " +A: " << a.uid << " `" << static_cast<int>(a.answer) << "` Q"
              << static_cast<size_t>(a.qid) << '\n';
    box_.answers[a.qid][a.uid] = a.answer;
  }

  inline void Terminate() { std::cerr << '@' << name_ << " is done.\n"; }

  // TODO(dkorolev): Perhaps move the methronome into Bricks, and make it use a lambda?
  void Methronome() {
    // Update real-time plots every second.
    const MILLISECONDS_INTERVAL period = static_cast<MILLISECONDS_INTERVAL>(1000);

    auto q_total = sherlock::Stream<VizPoint<int>>(name_ + "_q_total");

    HTTP(port_).Register("/" + name_ + "/d/q_total/data", [&q_total](Request r) {
      q_total.Subscribe(new ServeRawPubSubOverHTTP<VizPoint<int>>(std::move(r))).Detach();
    });

    // Keep pushing data into the
    EPOCH_MILLISECONDS now = Now();
    while (true) {
      std::cerr << "HA\n";
      // TODO(dkorolev): This call should go via an MQ.
      q_total.Publish(VizPoint<int>{static_cast<double>(now), static_cast<int>(box_.questions.size())});
      bricks::time::SleepUntil(now + period);
      now = Now();
    }
  }

 private:
  const int port_;
  const std::string& name_;
  std::thread methronome_thread_;
  Box box_;

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
        cruncher_(port_, name_),
        cruncher_subscription_scope_(db_->Subscribe(cruncher_)),
        controller_boilerplate_html_(
            FileSystem::ReadFileAsString(FileSystem::JoinPath("static", "controls.html"))) {
    // The main controller page.
    HTTP(port_)
        .Register("/" + name_ + "/actions", std::bind(&Controller::Actions, this, std::placeholders::_1));

    // Raw PubSub as JSON.
    HTTP(port_).Register("/" + name_ + "/raw", [this](Request r) {
      db_->Subscribe(new ServeRawPubSubOverHTTP<std::unique_ptr<db::Record>>(std::move(r))).Detach();
    });

    // Pre-populate a few users, questions and answers.
    db->DoAddUser("dima", Now() - MILLISECONDS_INTERVAL(5000));
    db->DoAddUser("alice", Now() - MILLISECONDS_INTERVAL(4000));
    db->DoAddUser("bob", Now() - MILLISECONDS_INTERVAL(3000));
    db->DoAddUser("charles", Now() - MILLISECONDS_INTERVAL(2000));
    const auto vi = db->DoAddQuestion("Vi is the best text editor.", Now() - MILLISECONDS_INTERVAL(4500)).qid;
    const auto weed = db->DoAddQuestion("Marijuana should be legal.", Now() - MILLISECONDS_INTERVAL(3500)).qid;
    const auto bubble = db->DoAddQuestion("We are in the bubble.", Now() - MILLISECONDS_INTERVAL(2500)).qid;
    const auto movies = db->DoAddQuestion("Movies are getting worse.", Now() - MILLISECONDS_INTERVAL(1500)).qid;
    db->DoAddAnswer("dima", vi, db::ANSWER::YES, Now());
    db->DoAddAnswer("dima", weed, db::ANSWER::YES, Now());
    db->DoAddAnswer("dima", bubble, db::ANSWER::NO, Now());
    db->DoAddAnswer("dima", movies, db::ANSWER::YES, Now());
    db->DoAddAnswer("alice", vi, db::ANSWER::NO, Now());
    db->DoAddAnswer("alice", weed, db::ANSWER::NO, Now());
    db->DoAddAnswer("bob", movies, db::ANSWER::NO, Now());
    db->DoAddAnswer("bob", bubble, db::ANSWER::YES, Now());
    db->DoAddAnswer("charles", vi, db::ANSWER::NO, Now());
    db->DoAddAnswer("charles", weed, db::ANSWER::NO, Now());
    db->DoAddAnswer("charles", bubble, db::ANSWER::YES, Now());
    db->DoAddAnswer("charles", movies, db::ANSWER::NO, Now());
  }

  void Actions(Request r) {
    std::ostringstream table;
    Cruncher::Box box = cruncher_.GetBox();
    table << "<tr><td></td>";
    for (const auto& u : box.users) {
      table << "<td align=center><b>" << u << "</b></td>";
    }
    table << "<tr>\n";
    for (size_t qi = 0; qi < box.questions.size(); ++qi) {
      const auto& q = box.questions[qi];
      table << "<tr><td align=right><b>" << q << "</b></td>";
      std::map<db::UID, db::ANSWER>& current_answers = box.answers[static_cast<db::QID>(qi + 1)];
      for (const auto& u : box.users) {
        table << "<td align=center>";
        struct ValueTextColor {
          int value;
          const char* text;
          const char* color;
        };
        static constexpr ValueTextColor options[3] = {
            {-1, "No", "red"}, {0, "N/A", "gray"}, {+1, "Yes", "green"}};
        const int current_answer = static_cast<int>(current_answers[u]);
        for (size_t i = 0; i < 3; ++i) {
          if (i) {
            table << " | ";
          }
          if (options[i].value != current_answer) {
            table << Printf("<a href='add_answer?uid=%s&qid=%d&answer=%d'>%s</a>",
                            u.c_str(),
                            static_cast<int>(qi + 1),
                            options[i].value,
                            options[i].text);
          } else {
            table << Printf("<b><font color=%s>%s</font></b>", options[i].color, options[i].text);
          }
        }
        table << "</td>";
      }
      table << "</tr>\n";
    }
    r(Printf(controller_boilerplate_html_.c_str(), table.str().c_str()), HTTPResponseCode.OK, "text/html");
  }

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
