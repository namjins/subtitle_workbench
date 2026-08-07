#!/usr/bin/env node
const [, , imagePath, language = "eng"] = process.argv;

process.stdout.write(
  `${JSON.stringify({
    text: imagePath ? `external ${language}` : "",
    confidence: 0.5,
    model: "echo-example",
  })}\n`,
);
