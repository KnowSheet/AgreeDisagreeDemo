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
#include "../Bricks/graph/gnuplot.h"
#include "../Bricks/dflags/dflags.h"
#include "../Bricks/util/singleton.h"
#include "../fncas/fncas/fncas.h"

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
  EPOCH_MILLISECONDS ExtractTimestamp() const { return static_cast<EPOCH_MILLISECONDS>(x); }
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
        consumer_(demo_id_, image_),
        mq_(consumer_),
        metronome_thread_(&Cruncher::Metronome, this) {
    try {
      // Data streams.
      HTTP(port).Register("/" + demo_id_ + "/layout/d/u_total_data", u_total_);
      HTTP(port).Register("/" + demo_id_ + "/layout/d/q_total_data", q_total_);
      HTTP(port).Register("/" + demo_id_ + "/layout/d/image_data", image_);

      // The visualization comes from `Consumer`/`Cruncher`, as well as the updates to this stream.
      if (false) {
        // TODO(dkorolev): This, of course, will be refactored. -- D.K.
        std::thread([this]() {
                      int index = 0;
                      while (true) {
                        // Note that in order for the `http://d0.knowsheet.local/...` URL-s to work,
                        // 1) `d0.knowsheet.local` should point to `localhost` in `/etc/hosts`, and
                        // 2) Port 80 should be forwarded (or the demo should run on it).
                        image_.Publish(VizPoint<std::string>{
                            static_cast<double>(bricks::time::Now()),
                            Printf("http://d0.knowsheet.local/lorempixel/%d.jpg", index + 1)});
                        index = (index + 1) % 10;
                        std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                      }
                    }).detach();
      }

      // The black magic of serving the dashboard.
      HTTP(port).ServeStaticFilesFrom(FileSystem::JoinPath("static", "js"), "/" + demo_id_ + "/static/");

      HTTP(port).Register("/" + demo_id_ + "/config", [this](Request r) {
        // The layout URL is an absolute URL, not relative to the config URL.
        r(dashboard::Config("/" + demo_id_ + "/layout"), "config");
      });

      HTTP(port).Register("/" + demo_id_ + "/layout", [](Request r) {
        using namespace dashboard::layout;
        // `/meta` URL-s are relative to `/layout`.
        r(Layout(Row({Col({Cell("/q_total_meta"), Cell("/u_total_meta")}), Cell("/image_meta")})), "layout");
      });

      HTTP(port).Register("/" + demo_id_ + "/layout/u_total_meta", [this](Request r) {
        auto meta = dashboard::PlotMeta();
        meta.options.caption = "Total users.";
        meta.data_url = "/d/u_total_data";
        r(meta, "meta");
      });

      HTTP(port).Register("/" + demo_id_ + "/layout/q_total_meta", [this](Request r) {
        auto meta = dashboard::PlotMeta();
        meta.options.caption = "Total questions.";
        meta.data_url = "/d/q_total_data";
        r(meta, "meta");
      });

      HTTP(port).Register("/" + demo_id_ + "/layout/image_meta", [this](Request r) {
        auto meta = dashboard::ImageMeta();
        meta.options.header_text = "Users' Agreement";
        meta.data_url = "/d/image_data";
        r(meta, "meta");
      });

      // Need a dedicated handler for '$DEMO_ID/' to serve the nicely looking dashboard.
      HTTP(port).Register(
          "/" + demo_id_ + "/",
          new bricks::net::api::StaticFileServer(
              bricks::FileSystem::ReadFileAsString(bricks::FileSystem::JoinPath("static", "index.html")),
              "text/html"));

      HTTP(port)
          .Register("/" + demo_id_ + "/layout/d/image_data/viz.png", [this](Request r) { mq_.EmplaceMessage(new VizMQMessage(std::move(r))); });
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

  struct VizMQMessage : schema::Base {
    Request request;
    VizMQMessage() = delete;
    explicit VizMQMessage(Request r) : request(std::move(r)) {}
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

    std::string current_image_;
    sherlock::StreamInstance<VizPoint<std::string>>& image_stream_;

    Consumer() = delete;
    Consumer(const std::string& demo_id, sherlock::StreamInstance<VizPoint<std::string>>& image_stream)
        : demo_id_(demo_id), current_image_(RegenerateImage(box_)), image_stream_(image_stream) {
      UpdateImageOnTheDashboard();
    }

    inline void OnMessage(std::unique_ptr<schema::Base>& message, size_t) {
      struct types {
        typedef schema::Base base;
        typedef std::tuple<schema::AnswerRecord,
                           schema::QuestionRecord,
                           schema::UserRecord,
                           FunctionMQMessage,
                           HTTPRequestMQMessage,
                           VizMQMessage,
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
      UpdateVisualization();
    }

    inline void operator()(schema::QuestionRecord& q) {
      std::cerr << '@' << demo_id_ << " +Q" << static_cast<size_t>(q.qid) << " : \"" << q.text << "\"\n";
      box_.questions.push_back(q.text);
    }

    inline void operator()(schema::AnswerRecord& a) {
      std::cerr << '@' << demo_id_ << " +A: " << a.uid << " `" << static_cast<int>(a.answer) << "` Q"
                << static_cast<size_t>(a.qid) << '\n';
      box_.answers[a.qid][a.uid] = a.answer;
      UpdateVisualization();
    }

    inline void operator()(FunctionMQMessage& message) { message.function_with_box(box_); }

    inline void operator()(HTTPRequestMQMessage& message) {
      message.http_function_with_box(std::move(message.request), box_);
    }

    inline void operator()(VizMQMessage& message) {
      message.request(current_image_, HTTPResponseCode.OK, "image/png");
    }

    inline void operator()(TickMQMessage& message) {
      message.p_u_total.Publish(VizPoint<int>{static_cast<double>(Now()), static_cast<int>(box_.users.size())});
      message.p_q_total.Publish(
          VizPoint<int>{static_cast<double>(Now()), static_cast<int>(box_.questions.size())});
    }

    // TODO(dkorolev): Move to optimizing non-static function here.
    struct StaticFunctionData {
      size_t N;
      std::vector<std::vector<size_t>> M;

      struct OutputPoint {
        double x;
        double y;
        const std::string& s;
      };

      std::vector<OutputPoint> data;

      template <typename T>
      static typename fncas::output<T>::type compute(const T& x) {
        const auto& data = bricks::Singleton<StaticFunctionData>();

        assert(x.size() == data.N * 2);  // Pairs of coordinates.

        // Prepare the input.
        std::vector<std::pair<typename fncas::output<T>::type, typename fncas::output<T>::type>> P(data.N);
        for (size_t i = 0; i < data.N; ++i) {
          P[i].first = x[i * 2];
          P[i].second = x[i * 2 + 1];
        }

        // Compute the cost function.
        typename fncas::output<T>::type result = 0.0;
        // Optimization: Keep the people who disagree with each other further away.
        for (size_t i = 0; i + 1 < data.N; ++i) {
          for (size_t j = i + 1; j < data.N; ++j) {
            const typename fncas::output<T>::type dx = P[j].first - P[i].first;
            const typename fncas::output<T>::type dy = P[j].second - P[i].second;
            const typename fncas::output<T>::type d = dx * dx + dy * dy;
            result += d * (data.M[i][j] + 3.0);
          }
        }

        // Regularization: Keep the points around the boundary of the { C={0,0}, R=1 } circle.
        typename fncas::output<T>::type regularization = 0.0;
        for (size_t i = 0; i < data.N; ++i) {
          const typename fncas::output<T>::type d = P[i].first * P[i].first + P[i].second * P[i].second;
          const typename fncas::output<T>::type d_minus_one = d - 1.0;
          const typename fncas::output<T>::type d_minus_one_squared = d_minus_one * d_minus_one;
          regularization += d_minus_one_squared;
        }

        // Minimize regularization, maximize result.
        return (regularization * 1.0) - result;
      }

      void Update(const Box& box) {
        auto& static_data = bricks::Singleton<StaticFunctionData>();
        size_t& N = static_data.N;
        std::vector<std::vector<size_t>>& M = static_data.M;

        const double t = static_cast<double>(bricks::time::Now());
        std::cerr << "Optimizing.\n";

        data.clear();

        N = box.users.size();

        if (N) {
          std::map<std::string, size_t> uid_remap;
          for (size_t i = 0; i < N; ++i) {
            uid_remap[box.users[i]] = i;
          }

          M = std::vector<std::vector<size_t>>(N, std::vector<size_t>(N, 0));

          for (const auto qit : box.answers) {
            std::vector<std::string> clusters[2];  // Disagree, Agree.
            for (const auto uit : qit.second) {
              if (uit.second == schema::ANSWER::DISAGREE) {
                clusters[0].push_back(uit.first);
              } else if (uit.second == schema::ANSWER::AGREE) {
                clusters[1].push_back(uit.first);
              }
            }
            if (!clusters[0].empty() && !clusters[1].empty()) {
              for (const auto& cit1 : clusters[0]) {
                for (const auto& cit2 : clusters[1]) {
                  ++M[uid_remap[cit1]][uid_remap[cit2]];
                  ++M[uid_remap[cit2]][uid_remap[cit1]];
                }
              }
            }
          }

          std::vector<double> x;
          for (size_t i = 0; i < N; ++i) {
            const double phi = M_PI * 2 * i / N;
            x.push_back(cos(phi));
            x.push_back(sin(phi));
          }

          for (size_t i = 0; i < N; ++i) {
            std::cerr << bricks::strings::Printf("P0 = { %+.3lf, %+.3lf }\n", x[i * 2], x[i * 2 + 1]);
          }

          fncas::OptimizerParameters params;
          params.SetValue("max_steps", 50);
          const auto result = fncas::ConjugateGradientOptimizer<StaticFunctionData>(params).Optimize(x);

          x = result.point;
          for (size_t i = 0; i < N; ++i) {
            std::cerr << bricks::strings::Printf("P1 = { %+.3lf, %+.3lf }\n", x[i * 2], x[i * 2 + 1]);
          }

          for (size_t i = 0; i < N; ++i) {
            std::cerr << bricks::strings::Printf("%10s", box.users[i].c_str());
            for (size_t j = 0; j < N; ++j) {
              std::cerr << ' ' << M[i][j];
            }
            std::cerr << std::endl;
          }

          for (size_t i = 0; i < N; ++i) {
            data.push_back(OutputPoint{x[i * 2], x[i * 2 + 1], box.users[i]});
          }
        }
        std::cerr << bricks::strings::Printf("Optimization took %.2lf seconds.\n",
                                             1e-3 * (static_cast<double>(bricks::time::Now()) - t));
      }
    };

    static std::string RegenerateImage(const Box& box) {
      bricks::Singleton<StaticFunctionData>().Update(box);

      using namespace bricks::gnuplot;
      const auto f = [](Plotter& p) {
        const auto& data = bricks::Singleton<StaticFunctionData>().data;
        for (const auto& cit : data) {
          p(cit.x, cit.y, cit.s);
        }
      };

      // TODO(dkorolev): Research more on `pngcairo`. It does look better for the demo. :-)
      return GNUPlot()
          .ImageSize(400, 400)
          .NoTitle()
          .NoKey()
          .NoTics()
          .NoBorder()
          .Plot(WithMeta(f).AsLabels())
          .OutputFormat("pngcairo");
    }

    void UpdateImageOnTheDashboard() {
      const double t = static_cast<double>(bricks::time::Now());
      // The image URL is relative to the data URL.
      image_stream_.Publish(VizPoint<std::string>{t, Printf("/viz.png?key=%lf", t)});
    }

    void UpdateVisualization() {
      current_image_ = RegenerateImage(box_);
      UpdateImageOnTheDashboard();
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
    HTTP(port_)
        .Register("/" + demo_id_ + "/a/", std::bind(&Controller::Actions, this, std::placeholders::_1));
    HTTP(port).Register("/" + demo_id_ + "/a", [this](Request r) {
      r("", HTTPResponseCode.Found, "text/html", HTTPHeaders().Set("Location", "/" + demo_id_ + "/a/"));
    });

    // Make the storage-level stream accessible to the outer world via PubSub.
    HTTP(port_).Register("/" + demo_id_ + "/a/raw", std::ref(*db_));

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
        r("", HTTPResponseCode.Found, "text/html", HTTPHeaders().Set("Location", "/" + demo_id + "/a/"));
      } catch (const bricks::Exception& e) {
        std::cerr << "Demo creation exception: " << e.What() << std::endl;
        throw;
      }
    } else {
      r(bricks::net::DefaultMethodNotAllowedMessage(), HTTPResponseCode.MethodNotAllowed, "text/html");
    }
  });

  // Images are now generated by the `Cruncher`. -- D.K.
  if (false) {
    // Lorempixel images.
    // HTTP(port).ServeStaticFilesFrom("lorempixel", "/lorempixel/");
    HTTP(port).Register("/viz.png", [](Request r) {
      using namespace bricks::gnuplot;
      const auto f = [](Plotter& p) {
        const int N = 7;
        for (int i = 0; i < N; ++i) {
          const double phi = M_PI * 2 * i / N;
          p(cos(phi), sin(phi), bricks::strings::Printf("P%d", i));
        }
      };
      // TODO(dkorolev): Research more on `pngcairo`. It does look better for the demo. :-)
      r(GNUPlot()
            .ImageSize(400, 400)
            .NoTitle()
            .NoKey()
            .NoTics()
            .NoBorder()
            .Plot(WithMeta(f).AsLabels())
            .OutputFormat("pngcairo"),
        HTTPResponseCode.OK,
        "image/png");
    });
  }

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
