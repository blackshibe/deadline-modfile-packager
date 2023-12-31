import BitBuffer from "@rbxts/bitbuffer";
import { DECODE_MODULE, WRITE_MODULE } from "./serialize/module";
import { SerializeAttachmentDeclaration } from "./serialize/type/attachment";
import { SerializeClassDeclaration } from "./serialize/type/class";
import { SerializeInstanceDeclaration } from "./serialize/type/instance";
import { SerializeMetadataDeclaration } from "./serialize/type/metadata";
import { InstanceReferenceSerialization } from "./serialize/property/InstanceReferenceSerialization";
import { INSTANCE_ID_TAG } from "./util/constants";

// shit declared by the game itself
export namespace Deadline {
	export type attachmentClassData = {
		name: string;
	};

	export type attachmentProperties = {
		name: string;
		// may be anything
	};

	export type runtimeAttachmentProperties = {
		name: string;
		// may be anything
	};
}

// modfile format spec
export namespace Modfile {
	export type properties = { [index: string]: string };

	export type file = {
		info?: Modfile.metadataDeclaration;
		version: number;
		class_declarations: Modfile.classDeclaration[];
		instance_declarations: Modfile.instanceDeclaration[];
	};

	export type metadataDeclaration = {
		name: string;
		description: string;
		author: string;
		image: string;
	};

	export type classDeclaration = {
		properties: Deadline.attachmentClassData;
		attachments: Modfile.attachmentDeclaration[];
	};

	export type instanceDeclaration = {
		position:
			| { kind: "attachment_root"; parent_id: number; instance_id: number }
			| { kind: "child"; parent_id: number; instance_id: number };
		instance: Instance;
	};

	export type attachmentDeclaration = {
		instance_id: number; // ID of the root model instance
		parent_class: string;
		properties: Deadline.attachmentProperties;
		runtime_properties: Deadline.runtimeAttachmentProperties;
	};

	// TODO distinction between ingame classes and modded classes
	export type compiledClass = {
		name: string;
	};
}

export namespace ModfilePackager {
	// modifying binary data to change the version may have side effects, reexport your mods with the new version instead
	export const PACKAGER_VERSION = 1;

	export function req_script_as<T>(root: Instance, name: string): T {
		let module = root.FindFirstChild(name);

		if (!module) throw `Error while requiring ${name} inside ${root.GetFullName()} (it doesn't exist)`;

		if (!module.IsA("ModuleScript"))
			throw `Error while requiring ${name} inside ${root.GetFullName()} (it's not a modulescript)`;

		return require(module) as T;
	}

	export const encode = (model: Instance) => {
		print("encoding", model.Name);

		let buffer = BitBuffer("");
		buffer.writeUInt8(PACKAGER_VERSION);

		let properties = req_script_as<Modfile.properties>(model, "info");
		WRITE_MODULE(SerializeMetadataDeclaration, buffer, {
			name: properties.name || "No name",
			description: properties.description || "No description",
			author: properties.author || "No author",
			image: properties.image || "No image",
		});

		let attachments = model.FindFirstChild("attachments");
		if (attachments) {
			let attachment_classes = attachments.GetChildren();
			let next_attachment_id = 0;

			attachment_classes.forEach((folder) => {
				print(`attachments/${folder.Name}`);
				WRITE_MODULE(SerializeClassDeclaration, buffer, {
					attachments: [],
					properties: {
						name: folder.Name,
					},
				});

				folder.GetChildren().forEach((attachment) => {
					print(`attachments/${folder.Name}/${attachment.Name}`);
					let model = attachment.FindFirstChild("model");
					if (!model) throw `${attachment.Name} is missing a model`;

					let properties = req_script_as<Deadline.attachmentProperties>(attachment, "properties");
					let runtime_properties = req_script_as<Deadline.runtimeAttachmentProperties>(
						attachment,
						"runtime_properties",
					);

					WRITE_MODULE(SerializeAttachmentDeclaration, buffer, {
						instance_id: next_attachment_id,
						parent_class: folder.Name,
						properties: properties,
						runtime_properties: runtime_properties,
					});

					let id = 0;
					model.SetAttribute(INSTANCE_ID_TAG, id);
					model.GetDescendants().forEach((element) => {
						id += 1;
						element.SetAttribute(INSTANCE_ID_TAG, id);
					});

					WRITE_MODULE(SerializeInstanceDeclaration, buffer, {
						position: {
							kind: "attachment_root",
							instance_id: model.GetAttribute(INSTANCE_ID_TAG) as number,
							parent_id: next_attachment_id,
						},
						instance: model,
					});

					next_attachment_id += 1;
				});
			});
		} else {
			print("no attachments found");
		}

		return buffer.dumpBase64();
	};

	export const decode_to_modfile = (input: string): string | Modfile.file => {
		print("decoding to modfile");

		let start_time = tick();
		let buffer = BitBuffer();
		buffer.writeBase64(input);

		let file: Modfile.file = {
			version: buffer.readUInt8(),
			class_declarations: [],
			instance_declarations: [],
		};

		if (file.version !== PACKAGER_VERSION)
			return `invalid packager version. mod is version ${file.version}, but packager uses ${PACKAGER_VERSION}`;

		InstanceReferenceSerialization.reset_instance_cache();
		while (DECODE_MODULE(file, buffer) && buffer.getLength() - buffer.getPointer() > 8) {}
		set_instance_parents(file);
		InstanceReferenceSerialization.set_instance_ids();

		print((tick() - start_time) * 1000, "ms to finish");

		return file;
	};

	const set_instance_parents = (modfile: Modfile.file) => {
		let { instance_declarations } = modfile;

		for (const [_, child] of pairs(instance_declarations)) {
			if (child.position.kind !== "child") continue;
			for (const [_, parent] of pairs(instance_declarations)) {
				if (parent === child) continue;
				if (child.position.parent_id === parent.position.instance_id) child.instance.Parent = parent.instance;
			}
		}
	};
}

export namespace ModfileProvider {
	export const LOADED_MODS: string[] = []; // compiled buffer data

	export const load_file = (file: string) => {
		LOADED_MODS.push(file);
	};
}

/*
    specification info for deadline mods
    for details on reading types, see @rbxts/bitbuffer implementation

    Mods start with a string
*/
