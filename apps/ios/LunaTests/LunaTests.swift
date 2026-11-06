import XCTest
@testable import Luna

final class PairingInfoTests: XCTestCase {
    func testValidLink() {
        let info = PairingInfo(
            urlString: "luna://connect?host=192.168.1.42&port=4753&token=ios-e2e-test-token-0123&tls=0"
        )
        XCTAssertEqual(info?.host, "192.168.1.42")
        XCTAssertEqual(info?.port, 4753)
        XCTAssertEqual(info?.token, "ios-e2e-test-token-0123")
        XCTAssertEqual(info?.tls, false)
    }

    func testDefaultsPortAndParsesTLS() {
        let info = PairingInfo(
            urlString: "luna://connect?host=100.64.1.7&token=0123456789abcdef&tls=1"
        )
        XCTAssertEqual(info?.port, 4753)
        XCTAssertEqual(info?.tls, true)
    }

    func testRejectsWrongSchemeAndHostAction() {
        XCTAssertNil(PairingInfo(urlString: "https://connect?host=a&token=0123456789abcdef"))
        XCTAssertNil(PairingInfo(urlString: "luna://other?host=a&token=0123456789abcdef"))
    }

    func testRejectsShortOrMissingToken() {
        XCTAssertNil(PairingInfo(urlString: "luna://connect?host=a&token=short"))
        XCTAssertNil(PairingInfo(urlString: "luna://connect?host=a"))
    }

    func testRejectsEmptyHostAndBadPort() {
        XCTAssertNil(PairingInfo(urlString: "luna://connect?host=&token=0123456789abcdef"))
        XCTAssertNil(PairingInfo(urlString: "luna://connect?host=a&port=0&token=0123456789abcdef"))
        XCTAssertNil(PairingInfo(urlString: "luna://connect?host=a&port=70000&token=0123456789abcdef"))
    }

    func testToleratesSurroundingWhitespace() {
        let info = PairingInfo(
            urlString: "  luna://connect?host=127.0.0.1&token=0123456789abcdef\n"
        )
        XCTAssertEqual(info?.host, "127.0.0.1")
    }
}

final class FrameCodecTests: XCTestCase {
    func testHello() throws {
        let text = #"{"type":"hello","protocolVersion":2,"availableModels":[{"id":"sonnet","label":"Sonnet","efforts":["low","high"],"defaultEffort":"high"}],"capabilities":{"chat":true,"streamingDeltas":true}}"#
        guard case .hello(let hello) = FrameCodec.decodeServerFrame(text) else {
            return XCTFail("expected .hello")
        }
        XCTAssertEqual(hello.protocolVersion, 2)
        XCTAssertEqual(hello.availableModels?.first?.id, "sonnet")
        XCTAssertEqual(hello.availableModels?.first?.defaultEffort, "high")
        XCTAssertEqual(hello.capabilities?.streamingDeltas, true)
    }

    func testThreadList() throws {
        let text = #"{"type":"thread-list","threads":[{"id":"t1","title":"hello","createdAt":1,"model":"sonnet","status":"idle","lastMessageAt":2,"lastMessagePreview":"hi"}]}"#
        guard case .threadList(let threads) = FrameCodec.decodeServerFrame(text) else {
            return XCTFail("expected .threadList")
        }
        XCTAssertEqual(threads.count, 1)
        XCTAssertEqual(threads[0].id, "t1")
        XCTAssertEqual(threads[0].status, "idle")
    }

    func testAssistantDeltaAndDone() {
        let delta = #"{"type":"assistant-delta","threadId":"t1","turnId":"u1","text":"part"}"#
        guard case .assistantDelta(let tid, let turn, let body) = FrameCodec.decodeServerFrame(delta) else {
            return XCTFail("expected .assistantDelta")
        }
        XCTAssertEqual(tid, "t1"); XCTAssertEqual(turn, "u1"); XCTAssertEqual(body, "part")

        let done = #"{"type":"assistant-done","threadId":"t1","turnId":"u1","seq":9,"message":{"id":"m1","seq":9,"ts":3,"role":"assistant","text":"part one"}}"#
        guard case .assistantDone(_, let doneTurn, let seq, let msg) = FrameCodec.decodeServerFrame(done) else {
            return XCTFail("expected .assistantDone")
        }
        XCTAssertEqual(doneTurn, "u1"); XCTAssertEqual(seq, 9); XCTAssertEqual(msg.text, "part one")
    }

    func testAssistantError() {
        let text = #"{"type":"assistant-error","threadId":"t1","turnId":null,"error":{"kind":"interrupted","message":"Request interrupted by user"}}"#
        guard case .assistantError(let tid, let turn, let kind, let msg) = FrameCodec.decodeServerFrame(text) else {
            return XCTFail("expected .assistantError")
        }
        XCTAssertEqual(tid, "t1"); XCTAssertNil(turn)
        XCTAssertEqual(kind, "interrupted"); XCTAssertTrue(msg.contains("interrupted"))
    }

    func testArchiveErrorDecodes() {
        let text = #"{"type":"thread-archive-error","threadId":"t1","reason":"not-found"}"#
        guard case .threadArchiveError(let tid, let reason) = FrameCodec.decodeServerFrame(text) else {
            return XCTFail("expected .threadArchiveError")
        }
        XCTAssertEqual(tid, "t1"); XCTAssertEqual(reason, "not-found")
    }

    func testUnknownTypeIsIgnoredNotNil() {
        guard case .ignored(let type) = FrameCodec.decodeServerFrame(#"{"type":"future-frame"}"#) else {
            return XCTFail("expected .ignored")
        }
        XCTAssertEqual(type, "future-frame")
    }

    func testMalformedJSONReturnsNil() {
        XCTAssertNil(FrameCodec.decodeServerFrame("not json"))
        XCTAssertNil(FrameCodec.decodeServerFrame(#"{"kind":"no-type-field"}"#))
        XCTAssertNil(FrameCodec.decodeServerFrame(#"{"type":"assistant-delta"}"#)) // missing fields
    }
}
