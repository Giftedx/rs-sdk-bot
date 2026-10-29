import {test,expect} from "bun:test";
import * as compatibility from "../src/session-recovery";
import * as worker from "../../core/src/session-recovery";
test("the old recovery API imports the same core worker without owning another CLI",()=>{
 expect(compatibility.recoverSession).toBe(worker.recoverSession);
 expect(compatibility.recoveryCloseModal).toBe(worker.recoveryCloseModal);
 expect(compatibility.RECOVERY_SCRIPT).toBe("packages/core/src/session-recovery.ts");
});
