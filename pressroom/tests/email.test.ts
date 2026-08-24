import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressedToInbox,
  extractTags,
  extractUrls,
} from "../src/sources/email.js";

test("real links are pulled out of a message", () => {
  const body = `Have a look at this.

https://example.com/the-piece

Sent from my iPhone`;
  assert.deepEqual(extractUrls(body), ["https://example.com/the-piece"]);
});

test("mail furniture is not mistaken for something to read", () => {
  const body = `<a href="https://example.com/good">read</a>
    https://track.list-manage.com/click?u=1
    https://ci3.googleusercontent.com/proxy/pixel.png
    https://example.com/logo.png
    https://example.com/prefs/unsubscribe?u=2
    https://mail.google.com/mail/u/0/#inbox`;

  assert.deepEqual(extractUrls(body), ["https://example.com/good"]);
});

test("trailing punctuation is not part of the link", () => {
  assert.deepEqual(extractUrls("See https://example.com/a-piece."), [
    "https://example.com/a-piece",
  ]);
  assert.deepEqual(extractUrls("(https://example.com/b)"), ["https://example.com/b"]);
});

test("the same link twice in one message is captured once", () => {
  const body = "https://example.com/x and again https://example.com/x";
  assert.deepEqual(extractUrls(body), ["https://example.com/x"]);
});

test("several links in one message all survive", () => {
  const urls = extractUrls("https://a.com/1\nhttps://b.com/2\nhttps://c.com/3");
  assert.equal(urls.length, 3);
});

test("hashtags in the subject become tags", () => {
  const { tags, text } = extractTags("#print The case against rubrics #education");
  assert.deepEqual(tags, ["print", "education"]);
  assert.equal(text, "The case against rubrics");
});

test("a subject with no hashtags is left alone", () => {
  const { tags, text } = extractTags("A piece about schools");
  assert.deepEqual(tags, []);
  assert.equal(text, "A piece about schools");
});

test("only mail sent to the capture address is captured", () => {
  const filter = "+paper";
  assert.equal(addressedToInbox("arslan+paper@gmail.com", filter), true);
  assert.equal(addressedToInbox("Arslan <ARSLAN+PAPER@gmail.com>", filter), true);
  assert.equal(addressedToInbox("arslan@gmail.com", filter), false);
  // An empty filter means the whole mailbox, for a dedicated folder.
  assert.equal(addressedToInbox("anyone@anywhere.com", ""), true);
});
