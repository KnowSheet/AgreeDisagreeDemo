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

#include "schema.h"
#include "db.h"
#include "dashboard.h"

CEREAL_REGISTER_TYPE_WITH_NAME(schema::Record, "0");
CEREAL_REGISTER_TYPE_WITH_NAME(schema::UserRecord, "U");
CEREAL_REGISTER_TYPE_WITH_NAME(schema::QuestionRecord, "Q");
CEREAL_REGISTER_TYPE_WITH_NAME(schema::AnswerRecord, "A");

#include "../Bricks/file/file.h"
#include "../Bricks/strings/util.h"
#include "../Bricks/time/chrono.h"
#include "../Bricks/rtti/dispatcher.h"
#include "../Bricks/net/api/api.h"
#include "../Bricks/mq/inmemory/mq.h"
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

// The `Box` structure encapsulates the state of the demo.
// All calls to it, updates and reads, go through the message queue, and thus are sequential.
struct Box {
  std::vector<std::string> users;
  std::vector<std::string> questions;
  std::map<schema::QID, std::map<schema::UID, schema::ANSWER>> answers;
};

// The `Cruncher` defines a real (no shit!) TailProduce worker.
// It maintains the consistency of the `Box` and allows access to it.
//
// `Cruncher` works with two inputs of two "universes":
// 1) The `storage::Record` entries, which update the state of the `Box`, and
// 2) The `*MQMessage` messages, which use the `Box` to generate API responses or for other needs (ex. timer).
//
// The inputs of both universes get delivered to the `Cruncher` via the message queue.
// Thus, they are processed sequentially, and no multithreading collisions can occur in the meantime.
class Cruncher final {
 public:
  Cruncher(int port, const std::string& demo_id)
      : demo_id_(demo_id),
        u_total_(sherlock::Stream<VizPoint<int>>(demo_id_ + "_u_total", "point")),
        q_total_(sherlock::Stream<VizPoint<int>>(demo_id_ + "_q_total", "point")),
        image_(sherlock::Stream<VizPoint<std::string>>(demo_id_ + "_image", "point")),
        consumer_(demo_id_),
        mq_(consumer_),
        metronome_thread_(&Cruncher::Metronome, this) {
    // TODO(dkorolev) + TODO(sompylasar): Resolve relative paths.
    try {
      // Data stream.
      HTTP(port).Register(/* "/" + demo_id_ + */ "/layout/d/u_total_data", u_total_);
      HTTP(port).Register(/* "/" + demo_id_ + */ "/layout/d/q_total_data", q_total_);
      HTTP(port).Register(/* "/" + demo_id_ + */ "/layout/d/image_data", image_);

      // TODO(dkorolev): This, of course, will be refactored. -- D.K.
      std::thread([this]() {
                    int index = 0;
                    while (true) {
                      // Note that in order for the `http://d0.knowsheet.local/lorempixel/%d.jpg` URL-s to work,
                      // 1) `d0.knowsheet.local` should point to `localhost` in `/etc/hosts`, and
                      // 2) Port 80 should be forwarded (or the demo should run on it).
                      image_.Publish(VizPoint<std::string>{
                          static_cast<double>(bricks::time::Now()),
                          Printf("http://d0.knowsheet.local/lorempixel/%d.jpg", index + 1)});
                      index = (index + 1) % 10;
                      std::this_thread::sleep_for(std::chrono::milliseconds(5000));
                    }
                  }).detach();

      // The black magic of serving the dashboard.
      HTTP(port).ServeStaticFilesFrom(FileSystem::JoinPath("static", "js"), /* "/" + demo_id_ + */ "/static/");

      HTTP(port).Register(/*"/" + demo_id_* + */ "/config", [this](Request r) {
        r(dashboard::Config("layout"), "config");  // URL relative to `config`.
      });

      HTTP(port).Register(/*"/" + demo_id_ + */ "/layout", [](Request r) {
        using namespace dashboard::layout;
        // `/meta` URL-s are relative to `/layout`.
        r(Layout(Row({Col({Cell("/q_total_meta"), Cell("/u_total_meta")}), Cell("/image_meta")})), "layout");
      });

      HTTP(port).Register(/* "/" + demo_id_ + */ "/layout/u_total_meta", [this](Request r) {
        auto meta = dashboard::Meta();
        meta.options.caption = "Total users.";
        meta.data_url = "/d/u_total_data";
        r(meta, "meta");
      });

      HTTP(port).Register(/* "/" + demo_id_ + */ "/layout/q_total_meta", [this](Request r) {
        auto meta = dashboard::Meta();
        meta.options.caption = "Total questions.";
        meta.data_url = "/d/q_total_data";
        r(meta, "meta");
      });

      HTTP(port).Register(/* "/" + demo_id_ + */ "/layout/image_meta", [this](Request r) {
        auto meta = dashboard::ImageMeta();
        meta.options.header_text = "Here be dragons.";
        meta.data_url = "/d/image_data";
        r(meta, "meta");
      });

      // Need a dedicated handler for '$DEMO_ID/' to serve the nicely looking dashboard.
      // WARNING! WARNING! WARNING! Removing the old handler is a temporary hack! -- D.K.
      HTTP(port).UnRegister("/");
      HTTP(port).Register(
          /* "/" + demo_id_ + */ "/",
          new bricks::net::api::StaticFileServer(
              bricks::FileSystem::ReadFileAsString(bricks::FileSystem::JoinPath("static", "index.html")),
              "text/html"));
    } catch (const bricks::Exception& e) {
      std::cerr << "Crunched constructor exception: " << e.What() << std::endl;
      throw;
    }
  }

  ~Cruncher() {
    // TODO(dkorolev): There should probably be a better, more Bricks-standard way to make use of a metronome.
    metronome_thread_.join();
  }

  struct FunctionMQMessage : schema::Base {
    std::function<void(Box&)> function_with_box;
    FunctionMQMessage() = delete;
    explicit FunctionMQMessage(std::function<void(Box&)> f) : function_with_box(f) {}
  };

  struct HTTPRequestMQMessage : schema::Base {
    Request request;
    std::function<void(Request, Box&)> http_function_with_box;
    HTTPRequestMQMessage() = delete;
    explicit HTTPRequestMQMessage(Request r, std::function<void(Request, Box&)> f)
        : request(std::move(r)), http_function_with_box(f) {}
  };

  struct TickMQMessage : schema::Base {
    typedef sherlock::StreamInstance<VizPoint<int>> stream_type;
    stream_type& p_u_total;
    stream_type& p_q_total;
    TickMQMessage() = delete;
    TickMQMessage(stream_type& u, stream_type& p) : p_u_total(u), p_q_total(p) {}
  };

  inline bool Entry(std::unique_ptr<schema::Base>& entry) {
    // Note: The following call transfers ownership away from the passed in `unique_ptr`
    // into the `unique_ptr` in the message queue.
    // Looks straighforward to me after refactoring everything around it, yet comments and very welcome. -- D.K.
    mq_.EmplaceMessage(entry.release());
    return true;
  }

  inline void Terminate() { std::cerr << '@' << demo_id_ << " is done.\n"; }

  void CallFunctionWithBox(std::function<void(Box&)> f) { mq_.EmplaceMessage(new FunctionMQMessage(f)); }

  void ServeRequestWithBox(Request r, std::function<void(Request, Box&)> f) {
    mq_.EmplaceMessage(new HTTPRequestMQMessage(std::move(r), f));
  }

  struct Consumer {
    const std::string& demo_id_;
    Box box_;
    Consumer() = delete;
    Consumer(const std::string& demo_id) : demo_id_(demo_id) {}

    inline void OnMessage(std::unique_ptr<schema::Base>& message, size_t) {
      struct types {
        typedef schema::Base base;
        typedef std::tuple<schema::AnswerRecord,
                           schema::QuestionRecord,
                           schema::UserRecord,
                           FunctionMQMessage,
                           HTTPRequestMQMessage,
                           TickMQMessage> derived_list;
        typedef bricks::rtti::RuntimeTupleDispatcher<base, derived_list> dispatcher;
      };
      types::dispatcher::DispatchCall(*message, *this);
    }

    inline void operator()(schema::Base&) { throw std::logic_error("Should not happen (schema::Base)."); }
    inline void operator()(schema::Record&) { throw std::logic_error("Should not happen (schema::Record)."); }

    inline void operator()(schema::UserRecord& u) {
      std::cerr << '@' << demo_id_ << " +U: " << u.uid << '\n';
      box_.users.push_back(u.uid);
    }

    inline void operator()(schema::QuestionRecord& q) {
      std::cerr << '@' << demo_id_ << " +Q" << static_cast<size_t>(q.qid) << " : \"" << q.text << "\"\n";
      box_.questions.push_back(q.text);
    }

    inline void operator()(schema::AnswerRecord& a) {
      std::cerr << '@' << demo_id_ << " +A: " << a.uid << " `" << static_cast<int>(a.answer) << "` Q"
                << static_cast<size_t>(a.qid) << '\n';
      box_.answers[a.qid][a.uid] = a.answer;
    }

    inline void operator()(FunctionMQMessage& message) { message.function_with_box(box_); }

    inline void operator()(HTTPRequestMQMessage& message) {
      message.http_function_with_box(std::move(message.request), box_);
    }

    inline void operator()(TickMQMessage& message) {
      message.p_u_total.Publish(VizPoint<int>{static_cast<double>(Now()), static_cast<int>(box_.users.size())});
      message.p_q_total.Publish(
          VizPoint<int>{static_cast<double>(Now()), static_cast<int>(box_.questions.size())});
    }
  };

  // TODO(dkorolev): There should probably be a better, more Bricks-standard way to make use of a metronome.
  void Metronome() {
    const MILLISECONDS_INTERVAL period = static_cast<MILLISECONDS_INTERVAL>(250);
    EPOCH_MILLISECONDS now = Now();
    while (true) {
      mq_.EmplaceMessage(new TickMQMessage(u_total_, q_total_));
      bricks::time::SleepUntil(now + period);
      now = Now();
    }
  }

 private:
  const std::string& demo_id_;

  sherlock::StreamInstance<VizPoint<int>> u_total_;
  sherlock::StreamInstance<VizPoint<int>> q_total_;
  sherlock::StreamInstance<VizPoint<std::string>> image_;

  Consumer consumer_;
  MMQ<Consumer, std::unique_ptr<schema::Base>> mq_;

  std::thread metronome_thread_;

  Cruncher() = delete;
  Cruncher(const Cruncher&) = delete;
  void operator=(const Cruncher&) = delete;
  Cruncher(Cruncher&&) = delete;
  void operator=(Cruncher&&) = delete;
};

struct Controller {
 public:
  explicit Controller(int port, const std::string& demo_id, db::Storage* db)
      : port_(port),
        demo_id_(demo_id),
        html_header_(FileSystem::ReadFileAsString(FileSystem::JoinPath("static", "actions_header.html"))),
        html_footer_(FileSystem::ReadFileAsString(FileSystem::JoinPath("static", "actions_footer.html"))),
        db_(db),
        cruncher_(port_, demo_id_),
        scope_(db_->Subscribe(cruncher_)) {
    // The main controller page.
    // TODO(dkorolev) + TODO(sompylasar): Resolve relative paths.
    HTTP(port_)
        .Register(/* "/" + demo_id_ + */ "/a/", std::bind(&Controller::Actions, this, std::placeholders::_1));
    HTTP(port).Register(/* "/" + demo_id_ + */ "/a", [this](Request r) {
      r("", HTTPResponseCode.Found, "text/html", HTTPHeaders().Set("Location", /* "/" + demo_id_ + */ "/a/"));
    });

    // Make the storage-level stream accessible to the outer world via PubSub.
    // TODO(dkorolev) + TODO(sompylasar): Resolve relative paths.
    HTTP(port_).Register(/* "/" + demo_id_ + */ "/a/raw", std::ref(*db_));

    // Pre-populate a few users, questions and answers to start from.
    db->DoAddUser("dima", Now() - MILLISECONDS_INTERVAL(5000));
    db->DoAddUser("alice", Now() - MILLISECONDS_INTERVAL(4000));
    db->DoAddUser("bob", Now() - MILLISECONDS_INTERVAL(3000));
    db->DoAddUser("charles", Now() - MILLISECONDS_INTERVAL(2000));

    const auto vi = db->DoAddQuestion("Vi is the best text editor.", Now() - MILLISECONDS_INTERVAL(4500)).qid;
    const auto weed = db->DoAddQuestion("Marijuana should be legal.", Now() - MILLISECONDS_INTERVAL(3500)).qid;
    const auto bubble = db->DoAddQuestion("We are in the bubble.", Now() - MILLISECONDS_INTERVAL(2500)).qid;
    const auto movies = db->DoAddQuestion("Movies are getting worse.", Now() - MILLISECONDS_INTERVAL(1500)).qid;

    db->DoAddAnswer("dima", vi, schema::ANSWER::AGREE, Now());
    db->DoAddAnswer("dima", weed, schema::ANSWER::AGREE, Now());
    db->DoAddAnswer("dima", bubble, schema::ANSWER::DISAGREE, Now());
    db->DoAddAnswer("dima", movies, schema::ANSWER::AGREE, Now());
    db->DoAddAnswer("alice", vi, schema::ANSWER::DISAGREE, Now());
    db->DoAddAnswer("alice", weed, schema::ANSWER::DISAGREE, Now());
    db->DoAddAnswer("bob", movies, schema::ANSWER::DISAGREE, Now());
    db->DoAddAnswer("bob", bubble, schema::ANSWER::AGREE, Now());
    db->DoAddAnswer("charles", vi, schema::ANSWER::DISAGREE, Now());
    db->DoAddAnswer("charles", weed, schema::ANSWER::DISAGREE, Now());
    db->DoAddAnswer("charles", bubble, schema::ANSWER::AGREE, Now());
    db->DoAddAnswer("charles", movies, schema::ANSWER::DISAGREE, Now());
  }

  void Actions(Request r) {
    // This request goes through the Cruncher's message queue to ensure no concurrent access to the box.
    cruncher_.ServeRequestWithBox(std::move(r), [this](Request r, Box& box) {
      std::ostringstream table;
      table << "<tr><td></td>";
      for (const auto& u : box.users) {
        table << "<td align=center><b>" << u << "</b></td>";
      }
      table << "<tr>\n";
      for (size_t qi = 0; qi < box.questions.size(); ++qi) {
        const auto& q = box.questions[qi];
        table << "<tr><td align=right><b>" << q << "</b></td>";
        std::map<schema::UID, schema::ANSWER>& current_answers = box.answers[static_cast<schema::QID>(qi + 1)];
        for (const auto& u : box.users) {
          table << "<td align=center>";
          struct VTC {  // VTC = { Value, Text, Color }.
            int value;
            const char* text;
            const char* color;
          };
          static constexpr VTC options[3] = {{-1, "No", "red"}, {0, "N/A", "gray"}, {+1, "Yes", "green"}};
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
      r(html_header_ + table.str() + html_footer_, HTTPResponseCode.OK, "text/html");
    });
  }

 private:
  const int port_;
  const std::string demo_id_;
  const std::string html_header_;
  const std::string html_footer_;

  db::Storage* db_;  // `db_` is owned by the creator of the instance of `Controller`.
  Cruncher cruncher_;
  typename sherlock::StreamInstance<std::unique_ptr<schema::Base>>::template ListenerScope<Cruncher> scope_;

  Controller() = delete;
};

int main() {
  const int port = FLAGS_port;

  // Create and redirect to a new demo when POST-ed onto `/new`.
  HTTP(port).Register("/new", [&port](Request r) {
    if (r.method == "POST") {
      try {
        uint64_t salt = static_cast<uint64_t>(Now());
        // Randomly generated `demo_id` w/o safety checking. -- D.K.
        std::string demo_id = "";
        for (size_t i = 0; i < 5; ++i) {
          demo_id = std::string(1, ('a' + (salt % 26))) + demo_id;  // "MSB" first ordering.
          salt /= 26;
        }
        auto demo = new db::Storage(port, demo_id);             // Lives forever. -- D.K.
        auto controller = new Controller(port, demo_id, demo);  // Lives forever. -- D.K.
        static_cast<void>(controller);
        // TODO(dkorolev) + TODO(sompylasar): Resolve relative paths.
        // r("", HTTPResponseCode.Found, "text/html", HTTPHeaders().Set("Location", "/" + demo_id + "/a/"));
        r("", HTTPResponseCode.Found, "text/html", HTTPHeaders().Set("Location", "/a/"));
      } catch (const bricks::Exception& e) {
        std::cerr << "Demo creation exception: " << e.What() << std::endl;
        throw;
      }
    } else {
      r(bricks::net::DefaultMethodNotAllowedMessage(), HTTPResponseCode.MethodNotAllowed, "text/html");
    }
  });

  // Lorempixel images.
  HTTP(port).ServeStaticFilesFrom("lorempixel", "/lorempixel/");

  // Landing page.
  const std::string dir = "static/";
  HTTP(port).ServeStaticFilesFrom(dir, "/static/");
  HTTP(port).Register(
      "/",
      new bricks::net::api::StaticFileServer(
          bricks::FileSystem::ReadFileAsString(FileSystem::JoinPath(dir, "landing.html")), "text/html"));

  // Run forever.
  HTTP(port).Join();
}
