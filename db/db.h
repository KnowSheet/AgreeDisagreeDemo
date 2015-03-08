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

#ifndef DB_H
#define DB_H

#include "../../Bricks/port.h"

#include <string>

#include "../../Bricks/cerealize/cerealize.h"
#include "../../Bricks/time/chrono.h"
#include "../../Bricks/net/api/api.h"
#include "../../Bricks/dflags/dflags.h"

#include "../../Sherlock/sherlock.h"

// Low-level storage layer and data schema for `AgreeDisagreeDemo`.
namespace db {

// Types for the storage.
typedef std::string UID;
enum class QID : size_t { NONE = 0 };

// Types defining storage records.
struct Record {
  virtual ~Record() = default;
  bricks::time::EPOCH_MILLISECONDS ms;
  template <typename A>
  void serialize(A& ar) {
    ar(CEREAL_NVP(ms));
  }
};

struct AddUser : Record {
  UID uid;
  template <typename A>
  void serialize(A& ar) {
    Record::serialize(ar);
    ar(CEREAL_NVP(uid));
  }
};

struct AddQuestion : Record {
  QID qid;
  std::string text;
  template <typename A>
  void serialize(A& ar) {
    Record::serialize(ar);
    ar(CEREAL_NVP(qid), CEREAL_NVP(text));
  }
};

}  // namespace db

CEREAL_REGISTER_TYPE_WITH_NAME(db::AddUser, "U");
CEREAL_REGISTER_TYPE_WITH_NAME(db::AddQuestion, "Q");

namespace db {
// The `AgreeDisagreeStorage` class, the instance of which governs
// low-level HTTP endpoints and the Sherlock stream for this instance of `AgreeDisagreeDemo`.

class AgreeDisagreeStorage final {
 public:
  // HTTP response schemas.
  struct Question final {
    Question() {}
    QID qid;
    std::string text;
    template <typename A>
    void serialize(A& ar) {
      ar(CEREAL_NVP(qid), CEREAL_NVP(text));
    }
  };

  struct User final {
    User() {}
    UID uid;
    std::map<QID, bool> answers;
    template <typename A>
    void serialize(A& ar) {
      ar(CEREAL_NVP(uid), CEREAL_NVP(answers));
    }
  };

  // Registers HTTP endpoints for the provided client name.
  // Ensures that questions indexing will start from 1 by adding a dummy question with index 0.
  AgreeDisagreeStorage(int port, const std::string& client_name)
      : port_(port),
        client_name_(client_name),
        sherlock_stream_(sherlock::Stream<std::unique_ptr<Record>>(client_name + "_db")),
        questions_({Question()}),
        questions_reverse_index_({{"", QID::NONE}}) {
    HTTP(port_).Register("/" + client_name_, [](Request r) { r("OK\n"); });
    HTTP(port_).Register("/" + client_name_ + "/q",
                         std::bind(&AgreeDisagreeStorage::HandleQ, this, std::placeholders::_1));
    HTTP(port_).Register("/" + client_name_ + "/u",
                         std::bind(&AgreeDisagreeStorage::HandleU, this, std::placeholders::_1));
    HTTP(port_).Register("/" + client_name_ + "/add_question",
                         std::bind(&AgreeDisagreeStorage::HandleAddQ, this, std::placeholders::_1));
    HTTP(port_).Register("/" + client_name_ + "/add_user",
                         std::bind(&AgreeDisagreeStorage::HandleAddU, this, std::placeholders::_1));
  }

  // Unregisters HTTP endpoints.
  ~AgreeDisagreeStorage() {
    HTTP(port_).UnRegister("/" + client_name_);
    HTTP(port_).UnRegister("/" + client_name_ + "/q");
    HTTP(port_).UnRegister("/" + client_name_ + "/u");
  }

  template <typename F>
  typename sherlock::StreamInstanceImpl<std::unique_ptr<Record>>::template ListenerScope<F> Subscribe(
      F& listener) {
    return sherlock_stream_.Subscribe(listener);
  }

  template <typename F>
  typename sherlock::StreamInstanceImpl<std::unique_ptr<Record>>::template ListenerScope<F> Subscribe(
      F* listener) {
    return sherlock_stream_.Subscribe(listener);
  }

 private:
  // Retrieves or creates questions.
  void HandleQ(Request r) {
    if (r.method == "GET") {
      const QID qid = static_cast<QID>(atoi(r.url.query["qid"].c_str()));
      if (qid == QID::NONE) {
        r("NEED QID\n", HTTPResponseCode.BadRequest);
      } else if (static_cast<size_t>(qid) >= questions_.size()) {
        r("QUESTION NOT FOUND\n", HTTPResponseCode.NotFound);
      } else {
        r(questions_[static_cast<size_t>(qid)]);
      }
    } else if (r.method == "POST") {
      HandleAddQ(std::move(r));
    } else {
      r("METHOD NOT ALLOWED\n", HTTPResponseCode.MethodNotAllowed);
    }
  }

  void HandleAddQ(Request r) {
    const std::string text = r.url.query["text"];
    if (text.empty()) {
      r("NEED TEXT\n", HTTPResponseCode.BadRequest);
    } else if (questions_reverse_index_.count(text)) {
      r("DUPLICATE QUESTION\n", HTTPResponseCode.BadRequest);
    } else {
      const QID qid = static_cast<QID>(questions_.size());
      questions_.push_back(Question());
      Question& new_question = questions_.back();
      new_question.qid = qid;
      new_question.text = text;
      questions_reverse_index_[text] = qid;
      AddQuestion record;
      record.ms = r.timestamp;
      record.qid = qid;
      record.text = text;
      sherlock_stream_.Publish(record);
      r(new_question, "question");
    }
  }

  // Retrieves or creates users.
  void HandleU(Request r) {
    const UID uid = r.url.query["uid"];
    if (uid.empty()) {
      r("NEED UID\n", HTTPResponseCode.BadRequest);
    } else {
      if (r.method == "GET") {
        const auto cit = users_.find(uid);
        if (cit != users_.end()) {
          r(cit->second, "user");
        } else {
          r("USER NOT FOUND\n", HTTPResponseCode.NotFound);
        }
      } else if (r.method == "POST") {
        HandleAddU(std::move(r));
      } else {
        r("METHOD NOT ALLOWED\n", HTTPResponseCode.MethodNotAllowed);
      }
    }
  }
  void HandleAddU(Request r) {
    const UID uid = r.url.query["uid"];
    if (uid.empty()) {
      r("NEED UID\n", HTTPResponseCode.BadRequest);
    } else {
      const auto cit = users_.find(uid);
      if (cit != users_.end()) {
        r("USER ALREADY EXISTS\n", HTTPResponseCode.BadRequest);
      } else {
        User& new_user = users_[uid];
        new_user.uid = uid;
        AddUser record;
        record.ms = r.timestamp;
        record.uid = uid;
        sherlock_stream_.Publish(record);
        r(new_user, "user");
      }
    }
  }

  const int port_;
  const std::string client_name_;

  sherlock::StreamInstance<std::unique_ptr<Record>> sherlock_stream_;

  std::vector<Question> questions_;
  std::map<std::string, QID> questions_reverse_index_;

  std::map<UID, User> users_;

  AgreeDisagreeStorage() = delete;
  AgreeDisagreeStorage(const AgreeDisagreeStorage&) = delete;
  AgreeDisagreeStorage(AgreeDisagreeStorage&&) = delete;
  void operator=(const AgreeDisagreeStorage&) = delete;
  void operator=(AgreeDisagreeStorage&&) = delete;
};

}  // namespace db

#endif  // DB_H
