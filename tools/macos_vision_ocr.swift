import Foundation
import ImageIO
import Vision

struct OcrLine: Encodable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
}

struct OcrResult: Encodable {
    let text: String
    let confidence: Float
    let lines: [OcrLine]
}

struct BatchResult: Encodable {
    let path: String
    let result: OcrResult?
    let error: String?
}

func languageCode(_ value: String) -> String {
    switch value {
    case "eng": return "en-US"
    case "fra": return "fr-FR"
    case "deu": return "de-DE"
    case "ita": return "it-IT"
    case "por": return "pt-BR"
    case "spa": return "es-ES"
    case "nld": return "nl-NL"
    case "jpn": return "ja-JP"
    case "kor": return "ko-KR"
    case "chi_sim": return "zh-Hans"
    case "chi_tra": return "zh-Hant"
    default: return value
    }
}

func recognize(imagePath: String, language: String) throws -> OcrResult {
    let imageURL = URL(fileURLWithPath: imagePath)
    guard
        let imageSource = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
    else {
        throw NSError(
            domain: "SubtitleWorkbenchVision",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Could not read image: \(imageURL.path)"]
        )
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let supportedLanguages = (try? request.supportedRecognitionLanguages()) ?? []
    if supportedLanguages.contains(language) {
        request.recognitionLanguages = [language]
    }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw NSError(
            domain: "SubtitleWorkbenchVision",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Vision OCR failed: \(error.localizedDescription)"]
        )
    }

    let observations = (request.results ?? []).sorted { left, right in
        let yDelta = abs(left.boundingBox.midY - right.boundingBox.midY)
        if yDelta > 0.03 {
            return left.boundingBox.midY > right.boundingBox.midY
        }
        return left.boundingBox.minX < right.boundingBox.minX
    }

    var lines: [OcrLine] = []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        lines.append(
            OcrLine(
                text: text,
                confidence: candidate.confidence,
                x: observation.boundingBox.minX,
                y: observation.boundingBox.midY
            )
        )
    }

    let confidence = lines.isEmpty
        ? 0
        : lines.map(\.confidence).reduce(0, +) / Float(lines.count)
    return OcrResult(
        text: lines.map(\.text).joined(separator: "\n"),
        confidence: confidence,
        lines: lines
    )
}

func writeJsonLine<T: Encodable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fputs("Usage: macos_vision_ocr <image-path> [language]\n       macos_vision_ocr --batch [language]\n", stderr)
    exit(2)
}

if arguments[1] == "--batch" {
    let language = arguments.count >= 3 ? languageCode(arguments[2]) : "en-US"
    while let line = readLine() {
        let imagePath = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if imagePath.isEmpty { continue }
        do {
            let result = try recognize(imagePath: imagePath, language: language)
            try writeJsonLine(BatchResult(path: imagePath, result: result, error: nil))
        } catch {
            try writeJsonLine(
                BatchResult(path: imagePath, result: nil, error: error.localizedDescription)
            )
        }
    }
} else {
    let language = arguments.count >= 3 ? languageCode(arguments[2]) : "en-US"
    do {
        let result = try recognize(imagePath: arguments[1], language: language)
        try writeJsonLine(result)
    } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
