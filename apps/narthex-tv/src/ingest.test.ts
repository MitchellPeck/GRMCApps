import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentTypeFor, detectKind, extensionOf, isBrowserImage, needsTranscode, safeFileName, titleFromFileName,
} from "./ingest";

test("detectKind sorts the three things the narthex screen shows", () => {
  assert.equal(detectKind("photo.JPG", ""), "image");
  assert.equal(detectKind("clip.mov", ""), "video");
  assert.equal(detectKind("announcements.pptx", ""), "deck");
  assert.equal(detectKind("bulletin.pdf", ""), "deck");
  assert.equal(detectKind("slides.key", ""), "deck");
});

test("detectKind falls back to the MIME type when the name has no extension", () => {
  assert.equal(detectKind("upload", "image/png"), "image");
  assert.equal(detectKind("upload", "video/mp4"), "video");
  assert.equal(detectKind("upload", "application/pdf"), "deck");
  assert.equal(
    detectKind("upload", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    "deck"
  );
});

test("detectKind refuses what we cannot put on a screen", () => {
  assert.equal(detectKind("budget.xlsx", ""), null);
  assert.equal(detectKind("sermon.mp3", "audio/mpeg"), null);
  assert.equal(detectKind("notes.txt", "text/plain"), null);
});

test("needsTranscode spares files a browser already plays", () => {
  assert.equal(needsTranscode("clip.mp4", "h264"), false);
  assert.equal(needsTranscode("clip.webm", "vp9"), false);
  assert.equal(needsTranscode("clip.mov", "h264"), true);   // container
  assert.equal(needsTranscode("clip.mp4", "prores"), true); // codec
});

test("isBrowserImage keeps a JPEG as-is and re-encodes a HEIC", () => {
  assert.equal(isBrowserImage("photo.jpg"), true);
  assert.equal(isBrowserImage("photo.png"), true);
  assert.equal(isBrowserImage("photo.heic"), false);
  assert.equal(isBrowserImage("scan.tiff"), false);
});

test("safeFileName cannot escape its directory", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("/tmp/evil.png"), "evil.png");
  assert.equal(safeFileName("Advent Week 1.png"), "Advent-Week-1.png");
  assert.equal(safeFileName("a`b$(c).jpg"), "a-b-c.jpg");
  assert.ok(!safeFileName("....//x.png").includes("/"));
});

test("titleFromFileName gives something readable to start from", () => {
  assert.equal(titleFromFileName("advent_week-1.png"), "advent week 1");
  assert.equal(titleFromFileName("/a/b/Sunday Announcements.pptx"), "Sunday Announcements");
  assert.equal(titleFromFileName(""), "Untitled");
});

test("contentTypeFor labels what the player fetches", () => {
  assert.equal(contentTypeFor("/data/media/1/play.mp4"), "video/mp4");
  assert.equal(contentTypeFor("/data/media/1/original-x.png"), "image/png");
  assert.equal(extensionOf("x.tar.gz"), "gz");
});
