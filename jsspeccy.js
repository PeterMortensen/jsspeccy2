/* Offsets into register set when read as register pairs */
var rpAF = 0;
var rpBC = 1;
var rpDE = 2;
var rpHL = 3;
var rpAF_ = 4;
var rpBC_ = 5;
var rpDE_ = 6;
var rpHL_ = 7;
var rpIX = 8;
var rpIY = 9;
var rpIR = 10;
var rpSP = 11;
var rpPC = 12;

var registerBuffer = new ArrayBuffer(26);

/* Expose registerBuffer as both register pairs and individual registers */
var regPairs = new Uint16Array(registerBuffer);
var regs = new Uint8Array(registerBuffer);

/*
Typed arrays are native-endian
(http://lists.w3.org/Archives/Public/public-script-coord/2010AprJun/0048.html, 
http://cat-in-136.blogspot.com/2011/03/javascript-typed-array-use-native.html)
so need to test endianness in order to know the offsets of individual registers
*/
regPairs[rpAF] = 0x0100;
if (regs[0] == 0x01) {
	/* big-endian */
	var rA = 0;
	var rF = 1;
	var rB = 2;
	var rC = 3;
	var rD = 4;
	var rE = 5;
	var rH = 6;
	var rL = 7;
	var rA_ = 8;
	var rF_ = 9;
	var rB_ = 10;
	var rC_ = 11;
	var rD_ = 12;
	var rE_ = 13;
	var rH_ = 14;
	var rL_ = 15;
	var rIXH = 16;
	var rIXL = 17;
	var rIYH = 18;
	var rIYL = 19;
	var rI = 20;
	var rR = 21;
} else {
	/* little-endian */
	var rF = 0;
	var rA = 1;
	var rC = 2;
	var rB = 3;
	var rE = 4;
	var rD = 5;
	var rL = 6;
	var rH = 7;
	var rF_ = 8;
	var rA_ = 9;
	var rC_ = 10;
	var rB_ = 11;
	var rE_ = 12;
	var rD_ = 13;
	var rL_ = 14;
	var rH_ = 15;
	var rIXL = 16;
	var rIXH = 17;
	var rIYL = 18;
	var rIYH = 19;
	var rR = 20;
	var rI = 21;
}

function Memory() {
	var self = {};
	
	var ramPages = [];
	for (var i = 0; i < 8; i++) {
		ramPages[i] = new Uint8Array(0x3fff);
	}
	
	var scratch = new Uint8Array(0x3fff);
	
	var readSlots = [
		roms['48.rom'],
		ramPages[5],
		ramPages[2],
		ramPages[0]
	]
	var writeSlots = [
		scratch,
		ramPages[5],
		ramPages[2],
		ramPages[0]
	]
	
	self.read = function(addr) {
		var page = readSlots[addr >> 14];
		return page[addr & 0x3fff];
	}
	self.write = function(addr, val) {
		var page = writeSlots[addr >> 14];
		page[addr & 0x3fff] = val;
	}
	
	return self;
}
var memory = Memory();

function IOBus() {
	var self = {};
	
	self.read = function(addr) {
		return 0xff;
	}
	self.write = function(addr, val) {
	}
	
	return self;
}
var ioBus = IOBus();

var tstates = 0; /* number of tstates since start if this frame */
var iff1 = 0, iff2 = 0, im = 0, halted = false;

var FRAME_LENGTH = 69888;

var FLAG_C = 0x01;
var FLAG_N = 0x02;
var FLAG_P = 0x04;
var FLAG_V = 0x04;
var FLAG_3 = 0x08;
var FLAG_H = 0x10;
var FLAG_5 = 0x10;
var FLAG_Z = 0x40;
var FLAG_S = 0x80;

/* tables for setting Z80 flags */

/* Whether a half carry occurred or not can be determined by looking at
	the 3rd bit of the two arguments and the result; these are hashed
	into this table in the form r12, where r is the 3rd bit of the
	result, 1 is the 3rd bit of the 1st argument and 2 is the
	third bit of the 2nd argument; the tables differ for add and subtract
	operations */
var halfcarryAddTable = new Uint8Array([0, FLAG_H, FLAG_H, FLAG_H, 0, 0, 0, FLAG_H]);
var halfcarrySubTable = new Uint8Array([0, 0, FLAG_H, 0, FLAG_H, 0, FLAG_H, FLAG_H]);

/* Similarly, overflow can be determined by looking at the 7th bits; again
	the hash into this table is r12 */
var overflowAddTable = new Uint8Array([0, 0, 0, FLAG_V, FLAG_V, 0, 0, 0]);
var overflowSubTable = new Uint8Array([0, FLAG_V, 0, 0, 0, 0, FLAG_V, 0]);

/* Some more tables; initialised in z80InitTables() */
var sz53Table = new Uint8Array(0x100); /* The S, Z, 5 and 3 bits of the index */
var parityTable = new Uint8Array(0x100); /* The parity of the lookup value */
var sz53pTable = new Uint8Array(0x100); /* OR the above two tables together */

function z80InitTables() {
	for (var i=0; i<0x100; i++) {
		sz53Table[i] = i & ( FLAG_3 | FLAG_5 | FLAG_S );
		var j = i, parity = 0;
		for (var k=0; k<8; k++) {
			parity ^= j & 1; j >>=1;
		}
		parityTable[i]= ( parity ? 0 : FLAG_P );
		sz53pTable[i] = sz53Table[i] | parityTable[i];
	}
	
	sz53Table[0] |= FLAG_Z;
	sz53pTable[0] |= FLAG_Z;
}
z80InitTables();

/* Opcode generator functions: each returns a parameterless function that performs the opcode */
function CP_R(r) {
	return function() {
		var cptemp = regs[rA] - regs[r];
		var lookup = ( (regs[rA] & 0x88) >> 3 ) | ( (regs[r] & 0x88) >> 2 ) | ( (cptemp & 0x88) >> 1 );
		regs[rF] = ( cptemp & 0x100 ? FLAG_C : ( cptemp ? 0 : FLAG_Z ) ) | FLAG_N | halfcarrySubTable[lookup & 0x07] | overflowSubTable[lookup >> 4] | ( regs[r] & ( FLAG_3 | FLAG_5 ) ) | ( cptemp & FLAG_S );
		tstates += 4;
	}
}
function DEC_R(r) {
	return function() {
		regs[rF] = (regs[rF] & FLAG_C ) | ( regs[r] & 0x0f ? 0 : FLAG_H ) | FLAG_N;
		regs[r]--;
		regs[rF] |= (regs[r] == 0x7f ? FLAG_V : 0) | sz53Table[regs[r]];
		tstates += 4;
	}
}
function DEC_RR(rp) {
	return function() {
		regPairs[rp]--;
		tstates += 6;
	}
}
function DI() {
	return function() {
		iff1 = iff2 = 0;
		tstates += 4;
	}
}
function EX_RR_RR(rp1, rp2) {
	return function() {
		var temp = regPairs[rp1];
		regPairs[rp1] = regPairs[rp2];
		regPairs[rp2] = temp;
		tstates += 4;
	}
}
function INC_R(r) {
	return function() {
		regs[r]++;
		regs[rF] = (regs[rF] & FLAG_C) | ( regs[r] == 0x80 ? FLAG_V : 0 ) | ( regs[r] & 0x0f ? 0 : FLAG_H ) | sz53Table[regs[r]];
		tstates += 4;
	}
}
function INC_RR(rp) {
	return function() {
		regPairs[rp]++;
		tstates += 6;
	}
}
function JP_N() {
	return function() {
		var l = memory.read(regPairs[rpPC]++);
		var h = memory.read(regPairs[rpPC]++);
		regPairs[rpPC] = (h<<8) | l;
		tstates += 10;
	}
}
function LD_iRRi_N(rp) {
	return function() {
		var n = memory.read(regPairs[rpPC]++);
		memory.write(regPairs[rp], n);
		tstates += 10;
	}
}
function LD_iRRi_R(rp, r) {
	return function() {
		memory.write(regPairs[rp], regs[r]);
		tstates += 7;
	}
}
function LD_R_N(r) {
	return function() {
		regs[r] = memory.read(regPairs[rpPC]++);
		tstates += 7;
	}
}
function LD_R_R(r1, r2) {
	if (r1 == rI && r2 == rA) {
		return function() {
			regs[r1] = regs[r2];
			tstates += 9;
		}
	} else {
		return function() {
			regs[r1] = regs[r2];
			tstates += 4;
		}
	}
}
function LD_RR_N(rp) {
	return function() {
		var l = memory.read(regPairs[rpPC]++);
		var h = memory.read(regPairs[rpPC]++);
		regPairs[rp] = (h<<8) | l;
		tstates += 10;
	}
}
function NOP() {
	return function() {
		tstates += 4;
	}
}
function OUT_iNi_A() {
	return function() {
		var port = memory.read(regPairs[rpPC]++);
		ioBus.write( (regs[rA] << 8) | port, regs[rA]);
		tstates += 11;
	}
}
function RLCA() {
	return function() {
		regs[rA] = (regs[rA] << 1) | (regs[rA] >> 7);
		regs[rF] = ( regs[rF] & ( FLAG_P | FLAG_Z | FLAG_S ) ) | ( regs[rA] & ( FLAG_C | FLAG_3 | FLAG_5) );
		tstates += 4;
	}
}
function SHIFT(opcodeTable) {
	/* Fake instruction for CB/ED-shifted opcodes */
	return function() {
		var opcode = memory.read(regPairs[rpPC]++);
		opcodeTable[opcode]();
	}
}
function XOR_R(r) {
	return function() {
		regs[rA] ^= regs[r];
		regs[rF] = sz53pTable[regs[rA]];
		tstates += 4;
	}
}

OPCODE_RUNNERS_ED = {
	0x47: /* LD I,A */     LD_R_R(rI, rA),
	0x100: 0 /* dummy line so I don't have to keep adjusting trailing commas */
}

OPCODE_RUNNERS = {
	0x00: /* NOP */        NOP(),
	0x01: /* LD BC,nnnn */ LD_RR_N(rpBC),
	0x02: /* LD (BC),A */  LD_iRRi_R(rpBC, rA),
	0x03: /* INC BC */     INC_RR(rpBC),
	0x04: /* INC B */      INC_R(rB),
	0x05: /* DEC B */      DEC_R(rB),
	0x06: /* LD B,nn */    LD_R_N(rB),
	0x07: /* RLCA */       RLCA(),
	0x08: /* EX AF,AF' */  EX_RR_RR(rpAF, rpAF_),
	
	0x0B: /* DEC BC */     DEC_RR(rpBC),
	0x0C: /* INC C */      INC_R(rC),
	0x0D: /* DEC C */      DEC_R(rC),
	0x0E: /* LD C,nn */    LD_R_N(rC),
	
	0x11: /* LD DE,nnnn */ LD_RR_N(rpDE),
	0x12: /* LD (DE),A */  LD_iRRi_R(rpDE, rA),
	0x13: /* INC DE */     INC_RR(rpDE),
	0x14: /* INC D */      INC_R(rD),
	0x15: /* DEC D */      DEC_R(rD),
	0x16: /* LD D,nn */    LD_R_N(rD),
	
	0x1B: /* DEC DE */     DEC_RR(rpDE),
	0x1C: /* INC E */      INC_R(rE),
	0x1D: /* DEC E */      DEC_R(rE),
	0x1E: /* LD E,nn */    LD_R_N(rE),
	
	0x21: /* LD HL,nnnn */ LD_RR_N(rpHL),
	
	0x23: /* INC HL */     INC_RR(rpHL),
	0x24: /* INC H */      INC_R(rH),
	0x25: /* DEC H */      DEC_R(rH),
	0x26: /* LD H,nn */    LD_R_N(rH),
	
	0x2B: /* DEC HL */     DEC_RR(rpHL),
	0x2C: /* INC L */      INC_R(rL),
	0x2D: /* DEC L */      DEC_R(rL),
	0x2E: /* LD L,nn */    LD_R_N(rL),
	
	0x31: /* LD SP,nnnn */ LD_RR_N(rpSP),
	
	0x33: /* INC SP */     INC_RR(rpSP),
	
	0x36: /* LD (HL),nn */ LD_iRRi_N(rpHL),
	
	0x3B: /* DEC SP */     DEC_RR(rpSP),
	0x3C: /* INC A */      INC_R(rA),
	
	0x3E: /* LD A,nn */    LD_R_N(rA),
	
	0x40: /* LD B,B */     LD_R_R(rB, rB),
	0x41: /* LD B,C */     LD_R_R(rB, rC),
	0x42: /* LD B,D */     LD_R_R(rB, rD),
	0x43: /* LD B,E */     LD_R_R(rB, rE),
	0x44: /* LD B,H */     LD_R_R(rB, rH),
	0x45: /* LD B,L */     LD_R_R(rB, rL),
	
	0x47: /* LD B,A */     LD_R_R(rB, rA),
	0x48: /* LD C,B */     LD_R_R(rC, rB),
	0x49: /* LD C,C */     LD_R_R(rC, rC),
	0x4a: /* LD C,D */     LD_R_R(rC, rD),
	0x4b: /* LD C,E */     LD_R_R(rC, rE),
	0x4c: /* LD C,H */     LD_R_R(rC, rH),
	0x4d: /* LD C,L */     LD_R_R(rC, rL),
	
	0x4f: /* LD C,A */     LD_R_R(rC, rA),
	0x50: /* LD D,B */     LD_R_R(rD, rB),
	0x51: /* LD D,C */     LD_R_R(rD, rC),
	0x52: /* LD D,D */     LD_R_R(rD, rD),
	0x53: /* LD D,E */     LD_R_R(rD, rE),
	0x54: /* LD D,H */     LD_R_R(rD, rH),
	0x55: /* LD D,L */     LD_R_R(rD, rL),
	
	0x57: /* LD D,A */     LD_R_R(rD, rA),
	0x58: /* LD E,B */     LD_R_R(rE, rB),
	0x59: /* LD E,C */     LD_R_R(rE, rC),
	0x5a: /* LD E,D */     LD_R_R(rE, rD),
	0x5b: /* LD E,E */     LD_R_R(rE, rE),
	0x5c: /* LD E,H */     LD_R_R(rE, rH),
	0x5d: /* LD E,L */     LD_R_R(rE, rL),
	
	0x5f: /* LD E,A */     LD_R_R(rE, rA),
	0x60: /* LD H,B */     LD_R_R(rH, rB),
	0x61: /* LD H,C */     LD_R_R(rH, rC),
	0x62: /* LD H,D */     LD_R_R(rH, rD),
	0x63: /* LD H,E */     LD_R_R(rH, rE),
	0x64: /* LD H,H */     LD_R_R(rH, rH),
	0x65: /* LD H,L */     LD_R_R(rH, rL),
	
	0x67: /* LD H,A */     LD_R_R(rH, rA),
	0x68: /* LD L,B */     LD_R_R(rL, rB),
	0x69: /* LD L,C */     LD_R_R(rL, rC),
	0x6a: /* LD L,D */     LD_R_R(rL, rD),
	0x6b: /* LD L,E */     LD_R_R(rL, rE),
	0x6c: /* LD L,H */     LD_R_R(rL, rH),
	0x6d: /* LD L,L */     LD_R_R(rL, rL),
	
	0x6f: /* LD L,A */     LD_R_R(rL, rA),
	0x70: /* LD (HL),B */  LD_iRRi_R(rpHL, rB),
	0x71: /* LD (HL),C */  LD_iRRi_R(rpHL, rC),
	0x72: /* LD (HL),D */  LD_iRRi_R(rpHL, rD),
	0x73: /* LD (HL),E */  LD_iRRi_R(rpHL, rE),
	0x74: /* LD (HL),H */  LD_iRRi_R(rpHL, rH),
	0x75: /* LD (HL),L */  LD_iRRi_R(rpHL, rL),
	
	0x77: /* LD (HL),A */  LD_iRRi_R(rpHL, rA),
	0x78: /* LD A,B */     LD_R_R(rA, rB),
	0x79: /* LD A,C */     LD_R_R(rA, rC),
	0x7a: /* LD A,D */     LD_R_R(rA, rD),
	0x7b: /* LD A,E */     LD_R_R(rA, rE),
	0x7c: /* LD A,H */     LD_R_R(rA, rH),
	0x7d: /* LD A,L */     LD_R_R(rA, rL),
	
	0x7f: /* LD A,A */     LD_R_R(rA, rA),
	
	0xA8: /* XOR B */      XOR_R(rB),
	0xA9: /* XOR C */      XOR_R(rC),
	0xAA: /* XOR D */      XOR_R(rD),
	0xAB: /* XOR E */      XOR_R(rE),
	0xAC: /* XOR H */      XOR_R(rH),
	0xAD: /* XOR L */      XOR_R(rL),
	
	0xAF: /* XOR A */      XOR_R(rA),
	
	0xb8: /* CP B */       CP_R(rB),
	0xb9: /* CP C */       CP_R(rC),
	0xba: /* CP D */       CP_R(rD),
	0xbb: /* CP E */       CP_R(rE),
	0xbc: /* CP H */       CP_R(rH),
	0xbd: /* CP L */       CP_R(rL),
	
	0xbf: /* CP A */       CP_R(rA),
	
	0xC3: /* JP nnnn */    JP_N(),
	
	0xD3: /* OUT (nn),A */ OUT_iNi_A(),
	
	0xEB: /* EX DE,HL */   EX_RR_RR(rpDE, rpHL),
	
	0xED: /* shift code */ SHIFT(OPCODE_RUNNERS_ED),
	
	0xF3: /* DI */         DI(),
	
	0x100: 0 /* dummy line so I don't have to keep adjusting trailing commas */
}

function runFrame() {
	while (tstates < FRAME_LENGTH) {
		var opcode = memory.read(regPairs[rpPC]++);
		OPCODE_RUNNERS[opcode]();
	}
}

function maskableInterrupt() {
	if (halted) {
		regPairs[rpPC]++;
		halted = false;
	}
}

runFrame();
console.log(regPairs[rpPC]);