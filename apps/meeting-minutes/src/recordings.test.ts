import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extensionFor, recordingPath, meetingRecordingPath } from "./recordings";

test("extensionFor prefers a recognised filename extension", () => {
  assert.equal(extensionFor("item-4.m4a", "audio/webm"), "m4a");
  assert.equal(extensionFor("Recording.WAV", ""), "wav");
});

test("extensionFor falls back to the mime type", () => {
  assert.equal(extensionFor("blob", "audio/webm"), "webm");
  assert.equal(extensionFor("blob", "audio/mp4"), "m4a");
  assert.equal(extensionFor("blob", "audio/ogg"), "ogg");
  assert.equal(extensionFor("blob", "audio/mpeg"), "mp3");
  assert.equal(extensionFor("blob", "audio/wav"), "wav");
  assert.equal(extensionFor("blob", "audio/x-wav"), "wav");
  assert.equal(extensionFor("blob", "video/webm"), "webm");
});

test("extensionFor defaults to webm for anything unrecognised", () => {
  assert.equal(extensionFor("", ""), "webm");
  assert.equal(extensionFor("weird.xyz", "application/octet-stream"), "webm");
});

test("extensionFor cannot be used to escape the audio directory", () => {
  assert.equal(extensionFor("../../etc/passwd", ""), "webm");
  assert.equal(extensionFor("x.wav/../../evil", ""), "webm");
});

test("recordingPath nests by item id and names the file by recording id", () => {
  assert.equal(recordingPath("/data", 12, 34, "webm"), "/data/audio/12/34.webm");
});

test("meetingRecordingPath nests by meeting id", () => {
  assert.equal(meetingRecordingPath("/data", 4, 11, "webm"), "/data/audio/meeting-4/11.webm");
});
