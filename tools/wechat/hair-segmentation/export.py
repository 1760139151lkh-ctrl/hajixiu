"""Export the graph and unchanged float32 weights for the WeChat hair runner."""
import base64
import hashlib
import json
import math
from pathlib import Path
import sys

import tflite


KINDS = {
    'CONV_2D': 'conv',
    'DEPTHWISE_CONV_2D': 'depthwise',
    'PRELU': 'prelu',
    'ADD': 'add',
    'MaxPoolingWithArgmax2D': 'pool',
    'MaxUnpooling2D': 'unpool',
    'Convolution2DTransposeBias': 'transpose',
    'CONCATENATION': 'concat',
}


def export(source, destination):
    binary = source.read_bytes()
    if hashlib.sha256(binary).hexdigest() != '2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84':
        raise ValueError('Review operator compatibility before rebuilding with a different model.')
    model = tflite.Model.GetRootAs(binary)
    graph = model.Subgraphs(0)
    input_id, output_id = int(graph.Inputs(0)), int(graph.Outputs(0))
    tensors = [graph.Tensors(i) for i in range(graph.TensorsLength())]
    shape = [tuple(int(v) for v in tensor.ShapeAsNumpy()) for tensor in tensors]
    ops = [graph.Operators(i) for i in range(graph.OperatorsLength())]
    links = [(list(map(int, op.InputsAsNumpy())), list(map(int, op.OutputsAsNumpy()))) for op in ops]

    # Tensor storage can be reclaimed after the final operation that reads it.
    born, used = {input_id: -1}, {output_id: len(ops)}
    for i, (inputs, outputs) in enumerate(links):
        born.update((j, i) for j in outputs)
        used.update((j, i) for j in inputs)
    offsets, active, size = {}, [], 0
    for j, start in sorted(born.items(), key=lambda item: item[1]):
        active = [span for span in active if span[2] >= start]
        count = math.prod(shape[j])
        offset = 0
        for left, right, _ in sorted(active):
            if left >= offset + count:
                break
            offset = max(offset, right)
        active.append((offset, offset + count, used.get(j, start)))
        offsets[j] = offset
        size = max(size, offset + count)

    weights = bytearray()
    views = []
    for i, tensor in enumerate(tensors):
        buffer = model.Buffers(tensor.Buffer())
        count = math.prod(shape[i])
        if buffer.DataLength():
            offset = -(len(weights) // 4 + 1)
            weights.extend(bytes(buffer.DataAsNumpy()))
        else:
            offset = offsets[i]
        h, w, c = shape[i][-3:] if len(shape[i]) == 4 else (1, 1, shape[i][-1])
        views.append([offset, count, h, w, c])

    nodes = []
    for op, (inputs, outputs) in zip(ops, links):
        code = model.OperatorCodes(op.OpcodeIndex())
        custom = code.CustomCode()
        name = custom.decode() if custom else tflite.opcode2name(code.BuiltinCode())
        stride, dilation, padding, kh, kw = 1, 1, 0, 1, 1
        if name in ('CONV_2D', 'DEPTHWISE_CONV_2D'):
            options = tflite.Conv2DOptions() if name == 'CONV_2D' else tflite.DepthwiseConv2DOptions()
            table = op.BuiltinOptions()
            options.Init(table.Bytes, table.Pos)
            stride, dilation = options.StrideH(), options.DilationHFactor()
            _, kh, kw, _ = shape[inputs[1]]
            padding = (kh - 1) * dilation // 2 if options.Padding() == 0 else 0
        elif name == 'Convolution2DTransposeBias':
            _, kh, kw, _ = shape[inputs[1]]
            stride, padding = 2, (kh - 2) // 2
        nodes.append([KINDS[name], inputs, outputs, stride, dilation, padding, kh, kw])

    graph_data = {
        'size': size, 'input': input_id, 'output': output_id, 'views': views, 'nodes': nodes,
        'weights': base64.b64encode(weights).decode('ascii'),
    }
    destination.write_text('module.exports = ' + json.dumps(graph_data, separators=(',', ':')) + '\n',
                           encoding='utf-8')


if __name__ == '__main__':
    export(Path(sys.argv[1]), Path(sys.argv[2]))
